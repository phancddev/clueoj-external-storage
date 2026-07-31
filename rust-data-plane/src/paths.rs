use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

pub struct ProblemDataLock {
    file: File,
}

impl Drop for ProblemDataLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::flock(std::os::fd::AsRawFd::as_raw_fd(&self.file), libc::LOCK_UN);
        }
    }
}

/// Acquire the same advisory filesystem lock used by ClueOJ's Python writers.
///
/// Destructive restore/evict operations hold this lock while renaming the
/// problem directory, preventing an upload from being published into a folder
/// that is concurrently being replaced or removed.
pub fn lock_problem_data(root: &Path, problem_id: &str) -> AppResult<ProblemDataLock> {
    let sanitized: String = format!("problem:{problem_id}")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let lock_root = root.join(".locks");
    std::fs::create_dir_all(&lock_root)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_root.join(format!("{sanitized}.lock")))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if rc != 0 {
            return Err(AppError::Io(std::io::Error::last_os_error()));
        }
    }
    Ok(ProblemDataLock { file })
}

pub fn validate_relative_path(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    if p.is_absolute() || path.is_empty() {
        return Err(AppError::PathEscape(path.to_string()));
    }
    for component in p.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(AppError::PathEscape(path.to_string())),
        }
    }
    Ok(())
}

/// Validate a relative symlink without following it.
///
/// `target` may contain `.` or `..`, but resolving it from the link's parent
/// must remain inside the problem folder. Absolute links and links that escape
/// the problem root are rejected.
pub fn validate_symlink_target(link_path: &str, target: &str) -> AppResult<()> {
    validate_relative_path(link_path)?;
    let target_path = Path::new(target);
    if target.is_empty() || target_path.is_absolute() {
        return Err(AppError::PathEscape(format!("{link_path} -> {target}")));
    }

    let mut depth = Path::new(link_path)
        .parent()
        .map(|parent| parent.components().count())
        .unwrap_or(0);
    for component in target_path.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => depth -= 1,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::PathEscape(format!("{link_path} -> {target}")));
            }
        }
    }
    Ok(())
}

pub fn validate_problem_code(code: &str) -> AppResult<()> {
    validate_relative_path(code)
}

pub fn safe_problem_folder(root: &Path, code: &str) -> AppResult<PathBuf> {
    validate_problem_code(code)?;
    Ok(root.join(code))
}

pub fn safe_join(base: &Path, rel: &str) -> AppResult<PathBuf> {
    validate_relative_path(rel)?;
    Ok(base.join(rel))
}

pub fn safe_destination_under_root(root: &Path, dest: &Path) -> AppResult<PathBuf> {
    if dest.is_absolute() {
        let rel = dest
            .strip_prefix(root)
            .map_err(|_| AppError::PathEscape(dest.display().to_string()))?;
        let rel = rel.to_string_lossy().replace('\\', "/");
        validate_relative_path(&rel)?;
        Ok(dest.to_path_buf())
    } else {
        let rel = dest.to_string_lossy().replace('\\', "/");
        validate_relative_path(&rel)?;
        Ok(root.join(dest))
    }
}

pub fn normalized_relative_path(base: &Path, path: &Path) -> AppResult<String> {
    let rel = path
        .strip_prefix(base)
        .map_err(|_| AppError::PathEscape(path.display().to_string()))?;
    let value = rel.to_string_lossy().replace('\\', "/");
    validate_relative_path(&value)?;
    Ok(value)
}

pub fn validate_content_object_key(key: &str) -> AppResult<()> {
    let Some(rest) = key.strip_prefix("objects/sha256/") else {
        return Err(AppError::PathEscape(key.to_string()));
    };
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 2 || parts[0].len() != 2 || parts[1].len() != 64 {
        return Err(AppError::PathEscape(key.to_string()));
    }
    if parts[0] != &parts[1][..2]
        || !parts
            .iter()
            .all(|p| p.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(AppError::PathEscape(key.to_string()));
    }
    Ok(())
}

pub fn validate_managed_object_key(key: &str) -> AppResult<()> {
    if key.starts_with("objects/sha256/") {
        return validate_content_object_key(key);
    }

    let parts: Vec<&str> = key.split('/').collect();
    let valid_manifest = parts.len() == 4
        && parts[0] == "snapshots"
        && !parts[1].is_empty()
        && parts[1] != "."
        && parts[1] != ".."
        && parts[1]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        && parts[2]
            .parse::<i64>()
            .is_ok_and(|generation| generation > 0)
        && parts[3] == "manifest.json";
    if !valid_manifest {
        return Err(AppError::PathEscape(key.to_string()));
    }
    Ok(())
}
