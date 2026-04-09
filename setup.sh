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
# ~/.pi/agent/settings.json — merge extensions and remove deprecated pi-review-loop package
# ---------------------------------------------------------------------------
# Auto-discover all .ts extensions in .pi/extensions/
AGENT_STUFF_EXTENSIONS=()
shopt -s nullglob
for ext in "$SCRIPT_DIR/.pi/extensions/"*.ts; do
    AGENT_STUFF_EXTENSIONS+=("$ext")
done
shopt -u nullglob

if command -v jq &>/dev/null; then
    if [ ! -f "$PI_SETTINGS" ]; then
        echo '{}' > "$PI_SETTINGS"
    fi

    ext_json="[]"
    for ext in "${AGENT_STUFF_EXTENSIONS[@]}"; do
        ext_json=$(echo "$ext_json" | jq --arg e "$ext" '. + [$e]')
    done

    # Remove any existing extensions from this repo, then add current ones
    existing=$(jq -r '.extensions // []' "$PI_SETTINGS")
    merged=$(echo "$existing" | jq --arg repo "$SCRIPT_DIR" '[.[] | select(startswith($repo) | not)]' | jq --argjson new "$ext_json" '. + $new | unique')

    jq --argjson exts "$merged" '
        .extensions = $exts
        | .enableSkillCommands = true
        | .packages = ((.packages // []) | map(select(
            . != "npm:pi-review-loop"
            and . != "pi-review-loop"
            and ((type != "object") or ((.source // "") != "npm:pi-review-loop" and (.source // "") != "pi-review-loop"))
        )))
    ' \
        "$PI_SETTINGS" > "$PI_SETTINGS.tmp" && mv "$PI_SETTINGS.tmp" "$PI_SETTINGS"

    echo "  merged     $PI_SETTINGS ($(echo "$merged" | jq -r 'length') extensions)"
else
    echo "  WARNING    jq not found, skipping settings.json merge"
    echo "             install jq or manually add extensions to $PI_SETTINGS"
fi

# ---------------------------------------------------------------------------
# Install npm dependencies for project-local extensions
# ---------------------------------------------------------------------------
if [ -f "$SCRIPT_DIR/.pi/extensions/package.json" ]; then
    echo "  npm install .pi/extensions/"
    (cd "$SCRIPT_DIR/.pi/extensions" && npm install --silent)
fi

# Install npm dependencies for subdirectory extensions with their own package.json
for subpkg in "$SCRIPT_DIR/.pi/extensions/"*/package.json; do
    [ -f "$subpkg" ] || continue
    dir="$(dirname "$subpkg")"
    echo "  npm install .pi/extensions/$(basename "$dir")/"
    (cd "$dir" && npm install --silent)
done

echo ""

# ---------------------------------------------------------------------------
# Claude Code / Amp: ~/.claude/CLAUDE.md -> repo global/CLAUDE.md
# ---------------------------------------------------------------------------
if command -v claude &>/dev/null || command -v amp &>/dev/null || [ -d "$CLAUDE_DIR" ]; then
    mkdir -p "$CLAUDE_DIR"
    link "$SCRIPT_DIR/global/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
    echo ""
fi

# ---------------------------------------------------------------------------
# Claude Code / Amp: ~/.claude/skills/<name> -> repo skills/<name> (per skill)
#
# Both Claude Code and Amp discover skills by scanning ~/.claude/skills/ for
# SKILL.md files. In Claude Code each becomes a /<name> slash command.
#
# link() only touches names that match directories under ./skills/, so any
# unrelated skill in ~/.claude/skills/ (e.g. claudeception) is left alone.
# ---------------------------------------------------------------------------
if command -v claude &>/dev/null || command -v amp &>/dev/null || [ -d "$CLAUDE_DIR" ]; then
    CLAUDE_SKILLS_DIR="$CLAUDE_DIR/skills"
    mkdir -p "$CLAUDE_SKILLS_DIR"
    shopt -s nullglob
    for skill_dir in "$SCRIPT_DIR/skills/"*/; do
        [ -f "$skill_dir/SKILL.md" ] || continue
        skill_name="$(basename "$skill_dir")"
        link "${skill_dir%/}" "$CLAUDE_SKILLS_DIR/$skill_name"
        # Amp-specific: its loader picks up SKILL.md from *.bak directories,
        # which would shadow our symlink. Only clean up .bak when Amp is
        # installed, so Claude-only machines never silently delete a
        # user-owned skill that happened to collide with a repo skill name.
        if command -v amp &>/dev/null && [ -d "$CLAUDE_SKILLS_DIR/$skill_name.bak" ]; then
            rm -rf "$CLAUDE_SKILLS_DIR/$skill_name.bak"
            echo "  cleaned    $CLAUDE_SKILLS_DIR/$skill_name.bak"
        fi
    done
    shopt -u nullglob
    echo ""
fi

# ---------------------------------------------------------------------------
# Claude Code: review-loop hook and state directory
# ---------------------------------------------------------------------------
if command -v claude &>/dev/null || [ -d "$CLAUDE_DIR" ]; then
    CLAUDE_HOOKS_DIR="$CLAUDE_DIR/hooks"
    REVIEW_LOOP_DIR="$CLAUDE_DIR/review-loop"
    mkdir -p "$CLAUDE_HOOKS_DIR"
    mkdir -p "$REVIEW_LOOP_DIR"

    # 1. Hook script symlink + ensure executable
    chmod +x "$SCRIPT_DIR/global/claude-review-loop/hook.sh"
    link "$SCRIPT_DIR/global/claude-review-loop/hook.sh" "$CLAUDE_HOOKS_DIR/review-loop.sh"

    # 2. Prompts symlink
    link "$SCRIPT_DIR/global/claude-review-loop/prompts" "$REVIEW_LOOP_DIR/prompts"

    # 3. Verify prompt symlinks in repo resolve
    for pf in code.md plan.md; do
        if [ ! -r "$SCRIPT_DIR/global/claude-review-loop/prompts/$pf" ]; then
            echo "  WARNING    prompts/$pf does not resolve — review prompts will be broken"
        fi
    done

    # 4. Default config (only on first run)
    if [ ! -f "$REVIEW_LOOP_DIR/config.json" ]; then
        cat > "$REVIEW_LOOP_DIR/config.json" <<'CONFIG_EOF'
{
    "max_iterations": 7,
    "auto_trigger": false,
    "interrupt_behavior": "pause",
    "exit_patterns_mode": "default",
    "issues_fixed_patterns_mode": "default",
    "custom_exit_patterns": [],
    "custom_issues_fixed_patterns": [],
    "custom_trigger_patterns": [],
    "prompt_code": null,
    "prompt_plan": null
}
CONFIG_EOF
        echo "  created    $REVIEW_LOOP_DIR/config.json (defaults)"
    else
        echo "  ok         $REVIEW_LOOP_DIR/config.json (exists)"
    fi

    # 5. Merge Stop and UserPromptSubmit hooks into settings.json
    CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
    if command -v jq &>/dev/null; then
        if [ ! -f "$CLAUDE_SETTINGS" ]; then
            echo '{}' > "$CLAUDE_SETTINGS"
        fi

        # Backup once (first run only)
        if [ ! -f "$CLAUDE_SETTINGS.bak" ]; then
            cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.bak"
            echo "  backed up  $CLAUDE_SETTINGS → $CLAUDE_SETTINGS.bak"
        fi

        # Validate existing JSON
        if ! jq -e . "$CLAUDE_SETTINGS" >/dev/null 2>&1; then
            echo "  ERROR      $CLAUDE_SETTINGS is not valid JSON. Skipping hook merge."
            echo "             Restore from $CLAUDE_SETTINGS.bak if needed."
        else
            HOOK_PATH="~/.claude/hooks/review-loop.sh"
            for EVENT in Stop UserPromptSubmit; do
                jq --arg cmd "$HOOK_PATH" --arg event "$EVENT" '
                  .hooks[$event] = (
                    (.hooks[$event] // []) as $existing
                    | if ($existing | any(.hooks[]?.command == $cmd)) then
                        $existing
                      else
                        $existing + [{"hooks": [{"type": "command", "command": $cmd}]}]
                      end
                  )
                ' "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp.$$" && \
                    mv "$CLAUDE_SETTINGS.tmp.$$" "$CLAUDE_SETTINGS"
            done
            echo "  merged     $CLAUDE_SETTINGS hooks (Stop, UserPromptSubmit)"
        fi
    else
        echo "  WARNING    jq not found, skipping settings.json hook merge"
    fi

    # 6. Post-install sanity check
    local_fail=0
    if [ ! -x "$CLAUDE_HOOKS_DIR/review-loop.sh" ] && [ ! -L "$CLAUDE_HOOKS_DIR/review-loop.sh" ]; then
        echo "  WARNING    hook symlink not executable: $CLAUDE_HOOKS_DIR/review-loop.sh"
        local_fail=1
    fi
    if [ ! -r "$REVIEW_LOOP_DIR/prompts/code.md" ] || [ ! -r "$REVIEW_LOOP_DIR/prompts/plan.md" ]; then
        echo "  WARNING    prompt symlinks don't resolve"
        local_fail=1
    fi
    if command -v jq &>/dev/null && [ -f "$CLAUDE_SETTINGS" ]; then
        if ! jq -e '.hooks.Stop[]?.hooks[]? | select(.command | endswith("review-loop.sh"))' "$CLAUDE_SETTINGS" >/dev/null 2>&1; then
            echo "  WARNING    Stop hook entry missing from settings.json"
            local_fail=1
        fi
        if ! jq -e '.hooks.UserPromptSubmit[]?.hooks[]? | select(.command | endswith("review-loop.sh"))' "$CLAUDE_SETTINGS" >/dev/null 2>&1; then
            echo "  WARNING    UserPromptSubmit hook entry missing from settings.json"
            local_fail=1
        fi
        if ! jq -e '.' "$REVIEW_LOOP_DIR/config.json" >/dev/null 2>&1; then
            echo "  WARNING    config.json is not valid JSON"
            local_fail=1
        fi
    fi
    if [ "$local_fail" -eq 0 ]; then
        echo "  ✓ review-loop installation verified"
    fi
    echo ""
fi

# ---------------------------------------------------------------------------
# Ensure shim scripts are executable
# ---------------------------------------------------------------------------
for dir in intercepted-commands pixi-intercepted-commands; do
    target="$SCRIPT_DIR/$dir"
    if [ -d "$target" ]; then
        shopt -s nullglob
        files=("$target"/*)
        shopt -u nullglob
        if (( ${#files[@]} )); then
            chmod +x "${files[@]}"
            echo "  chmod +x   $target/*"
        fi
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
if [ -d "$CLAUDE_DIR/skills" ]; then
    for p in "$CLAUDE_DIR/skills/"*/; do
        [ -L "${p%/}" ] || continue
        echo "  ${p%/} -> $(readlink "${p%/}")"
    done
fi
echo ""
echo "Global extensions (auto-discovered):"
for f in "$PI_AGENT_DIR/extensions/"*.ts; do
    [ -e "$f" ] || continue
    echo "  $(basename "$f")"
done
echo ""
echo "Skills (pi):"
for f in "$PI_AGENT_DIR/skills/"*/; do
    [ -d "$f" ] || continue
    echo "  $(basename "$f")"
done
echo ""
echo "Skills (Claude Code / Amp):"
for f in "$CLAUDE_DIR/skills/"*/; do
    [ -L "${f%/}" ] && [ -f "$f/SKILL.md" ] || continue
    echo "  $(basename "$f")"
done
echo ""
echo "Settings extensions:"
if command -v jq &>/dev/null && [ -f "$PI_SETTINGS" ]; then
    jq -r '.extensions[]? // empty' "$PI_SETTINGS" | while read -r f; do echo "  $(basename "$f")"; done
fi
