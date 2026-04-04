#!/bin/sh
set -eu

mode="${1-}"
if [ -n "$mode" ]; then
  shift
  case "$mode" in
    *D*)
      mode=$(printf '%s' "$mode" | tr -d 'D')
      ;;
  esac
  exec /usr/bin/ar "$mode" "$@"
fi

exec /usr/bin/ar "$@"
