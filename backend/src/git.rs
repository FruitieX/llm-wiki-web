//! A thin wrapper around the `git` binary. The app keeps one clone and only
//! touches it while holding the repository lock (see `repo.rs`).

use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{io::AsyncWriteExt, process::Command};

#[derive(Debug)]
pub struct GitError {
    pub args: String,
    pub stderr: String,
}
impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "git {} failed: {}", self.args, self.stderr.trim())
    }
}
pub type GitResult<T> = std::result::Result<T, GitError>;

#[derive(Clone)]
pub struct Git {
    pub dir: PathBuf,
    pub ssh_command: Option<String>,
    pub author_name: String,
    pub author_email: String,
}

impl Git {
    fn command(&self, cwd: &Path, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        command
            .current_dir(cwd)
            .args([
                "-c",
                &format!("user.name={}", self.author_name),
                "-c",
                &format!("user.email={}", self.author_email),
                "-c",
                "core.quotePath=false",
                "-c",
                "advice.detachedHead=false",
            ])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(ssh) = &self.ssh_command {
            command.env("GIT_SSH_COMMAND", ssh);
        }
        command
    }

    async fn output(&self, cwd: &Path, args: &[&str], input: Option<&[u8]>) -> GitResult<Vec<u8>> {
        let failure = |stderr: String| GitError {
            args: args.join(" "),
            stderr,
        };
        let mut command = self.command(cwd, args);
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command
            .spawn()
            .map_err(|error| failure(error.to_string()))?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take().expect("piped stdin");
            stdin
                .write_all(input)
                .await
                .map_err(|error| failure(error.to_string()))?;
        }
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| failure("timed out after 120 s".into()))?
        .map_err(|error| failure(error.to_string()))?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            if stderr.trim().is_empty() {
                stderr = String::from_utf8_lossy(&output.stdout).into_owned();
            }
            Err(failure(stderr))
        }
    }

    pub async fn run(&self, args: &[&str]) -> GitResult<String> {
        let bytes = self.output(&self.dir, args, None).await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn run_with_input(&self, args: &[&str], input: &[u8]) -> GitResult<String> {
        let bytes = self.output(&self.dir, args, Some(input)).await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn clone_from(&self, url: &str, branch: &str) -> GitResult<()> {
        let parent = self.dir.parent().unwrap_or(Path::new("/"));
        let target = self.dir.to_string_lossy().into_owned();
        self.output(
            parent,
            &["clone", "--branch", branch, "--single-branch", url, &target],
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn rev(&self, name: &str) -> GitResult<String> {
        Ok(self
            .run(&["rev-parse", "--verify", "--quiet", name])
            .await?
            .trim()
            .to_string())
    }

    /// Path → blob id for every file at `HEAD`.
    pub async fn tree(&self) -> GitResult<Vec<(String, String)>> {
        let output = self.run(&["ls-tree", "-r", "-z", "HEAD"]).await?;
        Ok(output
            .split('\0')
            .filter_map(|entry| {
                let (meta, path) = entry.split_once('\t')?;
                let mut parts = meta.split(' ');
                let (_mode, kind, blob) = (parts.next()?, parts.next()?, parts.next()?);
                (kind == "blob").then(|| (path.to_string(), blob.to_string()))
            })
            .collect())
    }

    pub async fn blob(&self, id: &str) -> GitResult<String> {
        self.run(&["cat-file", "blob", id]).await
    }

    /// File contents at a revision, or `None` when the path did not exist.
    pub async fn show(&self, rev: &str, path: &str) -> GitResult<Option<String>> {
        match self.run(&["show", &format!("{rev}:{path}")]).await {
            Ok(text) => Ok(Some(text)),
            Err(error)
                if error.stderr.contains("does not exist")
                    || error.stderr.contains("exists on disk, but not in")
                    || error.stderr.contains("invalid object name")
                    || error.stderr.contains("bad revision") =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub async fn hash_object(&self, text: &str) -> GitResult<String> {
        Ok(self
            .run_with_input(&["hash-object", "--stdin"], text.as_bytes())
            .await?
            .trim()
            .to_string())
    }

    /// A three-way merge of plain texts. Returns the merged text and whether
    /// it still contains conflict markers.
    pub async fn merge_texts(
        &self,
        scratch: &Path,
        mine: &str,
        base: &str,
        theirs: &str,
    ) -> std::io::Result<(String, bool)> {
        let dir = tempfile::tempdir_in(scratch)?;
        let paths = [
            dir.path().join("mine"),
            dir.path().join("base"),
            dir.path().join("theirs"),
        ];
        for (path, text) in paths.iter().zip([mine, base, theirs]) {
            tokio::fs::write(path, text).await?;
        }
        let args: Vec<String> = [
            "merge-file",
            "-p",
            "-L",
            "your edit",
            "-L",
            "base",
            "-L",
            "upstream",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .chain(paths.iter().map(|path| path.to_string_lossy().into_owned()))
        .collect();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = self.command(&self.dir, &args).output().await?;
        // merge-file exits with the number of conflicts; negative means failure.
        let conflicts = output.status.code().unwrap_or(-1);
        if conflicts < 0 {
            return Err(std::io::Error::other(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
        }
        Ok((
            String::from_utf8_lossy(&output.stdout).into_owned(),
            conflicts > 0,
        ))
    }
}

/// GitHub's published SSH host keys, pinned so that the clone never trusts an
/// unknown host on first use.
pub const GITHUB_KNOWN_HOSTS: &str = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
";
