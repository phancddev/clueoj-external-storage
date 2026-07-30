#!/bin/sh
set -eu

uid="${STORAGE_RUST_UID:?STORAGE_RUST_UID is required; set it to the numeric owner of the problem root, usually id -u}"
gid="${STORAGE_RUST_GID:?STORAGE_RUST_GID is required; set it to the numeric group of the problem root, usually id -g}"

case "$uid:$gid" in
  *[!0-9:]* | :* | *: | *::*)
    echo "STORAGE_RUST_UID and STORAGE_RUST_GID must be numeric" >&2
    exit 64
    ;;
esac

if [ "$(id -u)" = "0" ]; then
  if ! getent group "$gid" >/dev/null 2>&1; then
    groupadd --gid "$gid" storage-runtime
  fi
  if ! getent passwd "$uid" >/dev/null 2>&1; then
    useradd --uid "$uid" --gid "$gid" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin storage-runtime
  fi
  if [ "${STORAGE_RUST_CHECK_PROBLEM_ROOT_WRITE:-true}" = "true" ]; then
    gosu "$uid:$gid" sh -eu -c '
      root="${STORAGE_PROBLEM_ROOT:-/problems}"
      test -d "$root"
      probe="$root/.storage-write-test.$$"
      : > "$probe"
      rm -f "$probe"
    '
  fi
  exec gosu "$uid:$gid" "$@"
fi

if [ "${STORAGE_RUST_CHECK_PROBLEM_ROOT_WRITE:-true}" = "true" ]; then
  root="${STORAGE_PROBLEM_ROOT:-/problems}"
  test -d "$root"
  probe="$root/.storage-write-test.$$"
  : > "$probe"
  rm -f "$probe"
fi

exec "$@"
