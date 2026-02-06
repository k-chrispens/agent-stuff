#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PI_AGENT_DIR="$HOME/.pi/agent"
PI_SETTINGS="$PI_AGENT_DIR/settings.json"
CLAUDE_DIR="$HOME/.claude"

echo "=== agent-stuff setup ==="
echo "Source: $SCRIPT_DIR"
echo ""

# ---------------------------------------------------------------------------
# Helper: create a symlink, backing up any existing target
# ---------------------------------------------------------------------------
link() {
    local src="$1" dst="$2"

    if [ -L "$dst" ]; then
        local current
        current="$(readlink "$dst")"
        if [ "$current" = "$src" ]; then
            echo "  ok         $dst -> $src"
            return
        fi
        rm "$dst"
        echo "  relinked   $dst -> $src (was $current)"
    elif [ -e "$dst" ]; then
        mv "$dst" "$dst.bak"
        echo "  backed up  $dst -> $dst.bak"
    fi

    ln -s "$src" "$dst"
    echo "  linked     $dst -> $src"
}

# ---------------------------------------------------------------------------
# ~/.pi/agent/extensions -> repo global/extensions
# ---------------------------------------------------------------------------
mkdir -p "$PI_AGENT_DIR"
link "$SCRIPT_DIR/global/extensions" "$PI_AGENT_DIR/extensions"

# ---------------------------------------------------------------------------
# ~/.pi/agent/skills -> repo skills
# ---------------------------------------------------------------------------
link "$SCRIPT_DIR/skills" "$PI_AGENT_DIR/skills"

# ---------------------------------------------------------------------------
# ~/.pi/agent/settings.json — merge extensions, preserve everything else
# ---------------------------------------------------------------------------
AGENT_STUFF_EXTENSIONS=(
    "$SCRIPT_DIR/pi-extensions/review.ts"
    "$SCRIPT_DIR/pi-extensions/files.ts"
    "$SCRIPT_DIR/pi-extensions/notify.ts"
    "$SCRIPT_DIR/pi-extensions/uv.ts"
    "$SCRIPT_DIR/pi-extensions/pixi.ts"
    "$SCRIPT_DIR/pi-extensions/loop.ts"
    "$SCRIPT_DIR/pi-extensions/vim.ts"
)

if command -v jq &>/dev/null; then
    if [ ! -f "$PI_SETTINGS" ]; then
        echo '{}' > "$PI_SETTINGS"
    fi

    ext_json="[]"
    for ext in "${AGENT_STUFF_EXTENSIONS[@]}"; do
        ext_json=$(echo "$ext_json" | jq --arg e "$ext" '. + [$e]')
    done

    existing=$(jq -r '.extensions // []' "$PI_SETTINGS")
    merged=$(echo "$existing" | jq --argjson new "$ext_json" '. + $new | unique')

    jq --argjson exts "$merged" '.extensions = $exts | .enableSkillCommands = true' \
        "$PI_SETTINGS" > "$PI_SETTINGS.tmp" && mv "$PI_SETTINGS.tmp" "$PI_SETTINGS"

    echo "  merged     $PI_SETTINGS ($(echo "$merged" | jq -r 'length') extensions)"
else
    echo "  WARNING    jq not found, skipping settings.json merge"
    echo "             install jq or manually add extensions to $PI_SETTINGS"
fi

echo ""

# ---------------------------------------------------------------------------
# Claude Code: ~/.claude/CLAUDE.md -> repo global/CLAUDE.md
# ---------------------------------------------------------------------------
if command -v claude &>/dev/null || [ -d "$CLAUDE_DIR" ]; then
    mkdir -p "$CLAUDE_DIR"
    link "$SCRIPT_DIR/global/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
    echo ""
fi

# ---------------------------------------------------------------------------
# Ensure shim scripts are executable
# ---------------------------------------------------------------------------
for dir in intercepted-commands pixi-intercepted-commands; do
    target="$SCRIPT_DIR/$dir"
    if [ -d "$target" ]; then
        chmod +x "$target"/*
        echo "  chmod +x   $target/*"
    fi
done

echo ""
echo "=== done ==="
echo ""
echo "Symlinks:"
for p in "$PI_AGENT_DIR/extensions" "$PI_AGENT_DIR/skills" "$CLAUDE_DIR/CLAUDE.md"; do
    if [ -L "$p" ]; then
        echo "  $p -> $(readlink "$p")"
    fi
done
echo ""
echo "Global extensions (auto-discovered):"
ls "$PI_AGENT_DIR/extensions/"*.ts 2>/dev/null | while read -r f; do echo "  $(basename "$f")"; done
echo ""
echo "Skills:"
ls -d "$PI_AGENT_DIR/skills/"*/ 2>/dev/null | while read -r f; do echo "  $(basename "$f")"; done
echo ""
echo "Settings extensions:"
if command -v jq &>/dev/null && [ -f "$PI_SETTINGS" ]; then
    jq -r '.extensions[]? // empty' "$PI_SETTINGS" | while read -r f; do echo "  $(basename "$f")"; done
fi
