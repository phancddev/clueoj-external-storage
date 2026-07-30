use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

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
