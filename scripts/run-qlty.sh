#!/bin/sh
set -eu

if command -v qlty >/dev/null 2>&1; then
	exec qlty "$@"
fi

if [ -x "$HOME/.qlty/bin/qlty" ]; then
	exec "$HOME/.qlty/bin/qlty" "$@"
fi

cat >&2 <<'EOF'
[commit-queue] qlty is required for this repository quality gate.

Install qlty with:
  curl https://qlty.sh | bash
EOF
exit 127
