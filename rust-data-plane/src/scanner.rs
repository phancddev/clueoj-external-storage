use std::collections::HashSet;
use std::path::Path;

use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::hasher::stable_sha256_file;
use crate::models::{FileEntry, ScanResult, Volume};
use crate::paths;

#[cfg(unix)]
fn statvfs_compat(path: &Path) -> std::io::Result<libc::statvfs> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes())?;
    let mut stat = unsafe { std::mem::zeroed::<libc::statvfs>() };
    let ret = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if ret != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(stat)
}

#[cfg(not(unix))]
fn statvfs_compat(_path: &Path) -> std::io::Result<libc::statvfs> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "statvfs not available on this platform",
    ))
}

#[cfg(unix)]
extern crate libc;

pub fn scan_volume(root: &Path) -> AppResult<Volume> {
    let stat = statvfs_compat(root).map_err(AppError::Io)?;
    let block_size = stat.f_frsize as u64;
    Ok(Volume {
        total_bytes: stat.f_blocks as u64 * block_size,
        free_bytes: stat.f_bfree as u64 * block_size,
        available_bytes: stat.f_bavail as u64 * block_size,
        observed_at: chrono::Utc::now(),
        stale: false,
    })
}

pub fn scan_problem_folder(root: &Path, code: &str) -> AppResult<ScanResult> {
    let folder = paths::safe_problem_folder(root, code)?;
    if !folder.exists() {
        return Err(AppError::ProblemFolderMissing(code.to_string()));
    }

    let mut files = Vec::new();
    let mut logical_bytes: u64 = 0;
    let mut allocated_bytes: u64 = 0;
    let mut archive_bytes: u64 = 0;
    let mut auxiliary_bytes: u64 = 0;
    let mut file_count: i64 = 0;
    let mut seen_inodes: HashSet<(u64, u64)> = HashSet::new();
    let mut inode_paths: std::collections::HashMap<(u64, u64), (String, String)> =
        std::collections::HashMap::new();

    for entry in WalkDir::new(&folder).follow_links(false).into_iter() {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                return Err(AppError::Internal(format!("walkdir error: {e}")));
            }
        };
        if entry.path() == folder {
            continue;
        }

        let file_type = entry.file_type();
        if file_type.is_symlink() {
            let rel_path = paths::normalized_relative_path(&folder, entry.path())?;
            let target = std::fs::read_link(entry.path()).map_err(AppError::Io)?;
            let target = target.to_str().ok_or_else(|| {
                AppError::SpecialFile(format!("non-UTF-8 symlink target: {rel_path}"))
            })?;
            paths::validate_symlink_target(&rel_path, target)?;
            let meta = std::fs::symlink_metadata(entry.path()).map_err(AppError::Io)?;
            #[cfg(unix)]
            use std::os::unix::fs::MetadataExt;
            #[cfg(unix)]
            let (dev, ino, nlink, blocks, mode) = (
                meta.dev(),
                meta.ino(),
                meta.nlink(),
                meta.blocks(),
                meta.mode(),
            );
            #[cfg(not(unix))]
            let (dev, ino, nlink, blocks, mode) = (0u64, 0u64, 1u64, 0u64, 0u32);
            let size = target.len() as u64;
            let allocated = blocks * 512;
            let sha = crate::hasher::sha256_bytes(target.as_bytes());
            logical_bytes += size;
            allocated_bytes += allocated;
            auxiliary_bytes += size;
            file_count += 1;
            files.push(FileEntry {
                path: rel_path,
                sha256: sha,
                size,
                allocated_bytes: allocated,
                dev,
                ino,
                nlink,
                mode,
                duplicate_of: None,
                symlink_target: Some(target.to_string()),
                is_dir: false,
            });
            continue;
        }

        let meta = entry
            .metadata()
            .map_err(|e| AppError::Internal(format!("metadata error: {e}")))?;

        if meta.is_dir() {
            continue;
        }
        if !meta.is_file() {
            return Err(AppError::SpecialFile(entry.path().display().to_string()));
        }

        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;

        #[cfg(unix)]
        let (dev, ino, nlink, blocks, mode) = (
            meta.dev(),
            meta.ino(),
            meta.nlink(),
            meta.blocks(),
            meta.mode(),
        );
        #[cfg(not(unix))]
        let (dev, ino, nlink, blocks, mode) = (0u64, 0u64, 1u64, 0u64, 0u32);

        let size = meta.len();
        let allocated = blocks * 512;
        let rel_path = paths::normalized_relative_path(&folder, entry.path())?;

        let is_dup = !seen_inodes.insert((dev, ino));

        let (sha, duplicate_of) = if is_dup {
            let (first_path, first_sha) = inode_paths
                .get(&(dev, ino))
                .cloned()
                .ok_or_else(|| AppError::Internal("missing hardlink inode root".to_string()))?;
            (first_sha, Some(first_path))
        } else {
            let hash = match stable_sha256_file(entry.path(), 2) {
                Ok(h) => h,
                Err(AppError::FileChurn(_)) => return Err(AppError::FileChurn(rel_path.clone())),
                Err(e) => return Err(e),
            };
            (hash, None)
        };
        if !is_dup {
            inode_paths.insert((dev, ino), (rel_path.clone(), sha.clone()));
        }

        if !is_dup {
            logical_bytes += size;
            allocated_bytes += allocated;
        }

        let file_name = entry.file_name().to_string_lossy().to_lowercase();
        let is_archive = file_name.ends_with(".zip")
            || file_name.ends_with(".tar")
            || file_name.ends_with(".gz")
            || file_name.ends_with(".7z");
        if is_archive {
            if !is_dup {
                archive_bytes += size;
            }
        } else if !is_dup {
            auxiliary_bytes += size;
        }

        file_count += 1;
        files.push(FileEntry {
            path: rel_path,
            sha256: sha,
            size,
            allocated_bytes: allocated,
            dev,
            ino,
            nlink,
            mode,
            duplicate_of,
            symlink_target: None,
            is_dir: false,
        });
    }

    Ok(ScanResult {
        problem_external_id: None,
        code: code.to_string(),
        logical_bytes,
        allocated_bytes,
        archive_bytes,
        auxiliary_bytes,
        file_count,
        files,
        observed_at: chrono::Utc::now(),
    })
}

pub fn list_problem_codes(root: &Path) -> AppResult<Vec<String>> {
    let mut codes = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                if !name.starts_with('.') {
                    codes.push(name.to_string());
                }
            }
        }
    }
    codes.sort();
    Ok(codes)
}

pub fn canonical_download_path_from_folder(folder: &Path, files: &[FileEntry]) -> Option<String> {
    let init = std::fs::read_to_string(folder.join("init.yml")).ok();
    let init_archive = init.as_deref().and_then(parse_init_archive);
    if let Some(archive) = init_archive {
        if files
            .iter()
            .any(|f| f.path == archive && f.symlink_target.is_none())
        {
            return Some(archive);
        }
    }
    None
}

fn parse_init_archive(init_yml: &str) -> Option<String> {
    for raw in init_yml.lines() {
        let line = raw.trim();
        let Some(value) = line.strip_prefix("archive:") else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if paths::validate_relative_path(value).is_ok() {
            return Some(value.replace('\\', "/"));
        }
    }
    None
}
