#!/usr/bin/env bash
# review-loop.sh — Iterative review loop for Claude Code
#
# Invoked two ways:
#   1. As a hook (no args): reads stdin JSON, branches on hook_event_name
#   2. As a subcommand: hook.sh <cmd> [args...]
#
# State is per-session (keyed by session_id) to support concurrent Claude
# Code instances. Config is global (~/.claude/review-loop/config.json).
#
# See global/claude-review-loop/README.md for full documentation.
set -euo pipefail

# ─── Preflight ───────────────────────────────────────────────────────────────
# If preflight fails, exit 0 so Claude Code doesn't treat a broken hook as a
# block signal. Degrade silently rather than interfere with the user's session.

if [ -z "${HOME:-}" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) review-loop: HOME unset, exiting" \
        >> /tmp/review-loop-preflight.log 2>/dev/null || true
    exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
    mkdir -p "$HOME/.claude/review-loop" 2>/dev/null || true
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) review-loop: jq not found in PATH, exiting" \
        >> "$HOME/.claude/review-loop/hook.log" 2>/dev/null || true
    exit 0
fi

# ─── Paths ───────────────────────────────────────────────────────────────────

STATE_DIR="${REVIEW_LOOP_STATE_DIR_OVERRIDE:-$HOME/.claude/review-loop}"
CONFIG_FILE="$STATE_DIR/config.json"
PROMPTS_DIR="$STATE_DIR/prompts"
LOG_FILE="$STATE_DIR/hook.log"

# ─── Runtime detection ───────────────────────────────────────────────────────

# Reverse tool (for transcript parsing)
if command -v tac >/dev/null 2>&1; then
    REVERSE="tac"
elif tail -r /dev/null 2>/dev/null; then
    REVERSE="tail -r"
else
    REVERSE="awk '{ lines[NR] = \$0 } END { for (i = NR; i >= 1; i--) print lines[i] }'"
fi

# PCRE grep (for lookbehind patterns)
if command -v ggrep >/dev/null 2>&1 && ggrep -P '' </dev/null 2>/dev/null; then
    GREP_P="ggrep -P"
elif grep -P '' </dev/null 2>/dev/null; then
    GREP_P="grep -P"
else
    GREP_P=""
fi

# \w support in ERE
if echo "ab" | grep -Eq '\w' 2>/dev/null; then
    USE_WORD_CLASS=1
else
    USE_WORD_CLASS=0
fi

# ─── Default patterns ────────────────────────────────────────────────────────
# Copied verbatim from pi-review-loop/settings.ts. These are ERE patterns
# (case-insensitive) except where noted as PCRE.

get_exit_patterns() {
    cat <<'PATTERNS'
no\s+(\w+\s+)?issues\s+found
no\s+(\w+\s+)?bugs\s+found
(^|\n)\s*(looks\s+good|all\s+good)[\s.,!]*($|\n)
PATTERNS
}

get_issues_fixed_patterns() {
    # Lines starting with PCRE: require PCRE mode (lookbehind)
    cat <<'PATTERNS'
issues?\s+(i\s+)?fixed
fixed\s+(the\s+)?(following|these|this|issues?|bugs?)
fixed\s+\d+\s+issues?
found\s+and\s+(fixed|corrected|resolved)
bugs?\s+(i\s+)?fixed
corrected\s+(the\s+)?(following|these|this)
PCRE:(?<!no\s)issues?\s+(i\s+)?(found|identified|discovered)
PCRE:(?<!no\s)problems?\s+(i\s+)?(found|identified|discovered)
changes?\s+(i\s+)?made
here'?s?\s+what\s+(i\s+)?(fixed|changed|corrected)
(issues|bugs|problems|changes|fixes)\s*:
ready\s+for\s+(another|the\s+next)\s+review
PATTERNS
}

get_trigger_patterns() {
    cat <<'PATTERNS'
\bimplement\s+(the\s+)?plan\b
\bimplement\s+(the\s+)?spec\b
\bimplement\s+(this\s+)?plan\b
\bimplement\s+(this\s+)?spec\b
\bstart\s+implementing\b.*\b(plan|spec)\b
\bgo\s+ahead\s+and\s+implement\b.*\b(plan|spec)\b
\blet'?s\s+implement\b.*\b(plan|spec)\b
\b(plan|spec)\b.*\bstart\s+implementing\b
\b(plan|spec)\b.*\bgo\s+ahead\s+and\s+implement\b
\b(plan|spec)\b.*\blet'?s\s+implement\b
read over all of the new code.*fresh eyes
PATTERNS
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

log() {
    local msg="$*"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    # Rotate if > 1 MiB
    local size=0
    if [ -f "$LOG_FILE" ]; then
        size=$(stat -f%z "$LOG_FILE" 2>/dev/null \
             || stat -c%s "$LOG_FILE" 2>/dev/null \
             || wc -c < "$LOG_FILE" 2>/dev/null \
             || echo 0)
    fi
    if [ "$size" -gt 1048576 ]; then
        mv "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
    fi
    echo "$ts $msg" >> "$LOG_FILE" 2>/dev/null || true
}

stale_sweep() {
    # Opportunistic cleanup of orphan state/pending files. Best-effort, silent.
    find "$STATE_DIR" -name 'state-*.json' -mmin +120 -delete 2>/dev/null || true
    find "$STATE_DIR" -name 'pending-*.json' -mmin +5 -delete 2>/dev/null || true
}

# ─── State helpers ───────────────────────────────────────────────────────────

read_state() {
    local sid="$1"
    local file="$STATE_DIR/state-${sid}.json"
    if [ ! -f "$file" ]; then
        return 0
    fi
    local data
    data=$(jq -e '.' "$file" 2>/dev/null) || { rm -f "$file"; return 0; }

    # Validate embedded session_id matches
    local embedded
    embedded=$(jq -r '.session_id // ""' <<<"$data")
    if [ "$embedded" != "$sid" ]; then
        log "WARN: state file session_id mismatch ($embedded != $sid), deleting"
        rm -f "$file"
        return 0
    fi

    # Stale TTL: 2 hours
    local last_updated now
    last_updated=$(jq -r '.last_updated // 0' <<<"$data")
    now=$(date +%s)
    if [ "$((now - last_updated))" -gt 7200 ]; then
        log "WARN: stale state for session $sid (last_updated=$last_updated), deleting"
        rm -f "$file"
        return 0
    fi

    printf '%s' "$data"
}

write_state() {
    local sid="$1" json="$2"
    local file="$STATE_DIR/state-${sid}.json"
    local tmp="${file}.tmp.$$"
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    if ! printf '%s\n' "$json" > "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    if ! mv "$tmp" "$file"; then
        rm -f "$tmp"
        return 1
    fi
    return 0
}

delete_state() {
    local sid="$1"
    rm -f "$STATE_DIR/state-${sid}.json"
}

set_paused() {
    local sid="$1" val="$2"
    local state
    state=$(read_state "$sid")
    if [ -z "$state" ]; then
        return 1
    fi
    local now
    now=$(date +%s)
    local new_state
    new_state=$(jq \
        --argjson paused "$val" \
        --argjson now "$now" \
        '.paused = $paused | .last_updated = $now' \
        <<<"$state") || return 1
    write_state "$sid" "$new_state"
}

# ─── Pending helpers ─────────────────────────────────────────────────────────

read_pending() {
    local sid="$1"
    local file="$STATE_DIR/pending-${sid}.json"
    if [ ! -f "$file" ]; then
        return 0
    fi
    local data
    data=$(jq -e '.' "$file" 2>/dev/null) || { rm -f "$file"; return 0; }

    # Stale TTL: 5 minutes
    local created_at now
    created_at=$(jq -r '.created_at // 0' <<<"$data")
    now=$(date +%s)
    if [ "$((now - created_at))" -gt 300 ]; then
        rm -f "$file"
        return 0
    fi

    printf '%s' "$data"
}

write_pending() {
    local sid="$1" cwd="$2" delayed="$3" kind="${4:-}" focus="${5:-}"
    local file="$STATE_DIR/pending-${sid}.json"
    local tmp="${file}.tmp.$$"
    local now
    now=$(date +%s)
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    jq -n \
        --arg sid "$sid" \
        --arg cwd "$cwd" \
        --argjson now "$now" \
        --argjson delayed "$delayed" \
        --arg kind "$kind" \
        --arg focus "$focus" \
        '{
            session_id: $sid,
            cwd: $cwd,
            created_at: $now,
            delayed: $delayed,
            kind: $kind,
            focus: $focus
        }' > "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
}

delete_pending() {
    local sid="$1"
    rm -f "$STATE_DIR/pending-${sid}.json"
}

# ─── Config ──────────────────────────────────────────────────────────────────

read_config() {
    local defaults
    defaults='{
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
    }'
    if [ ! -f "$CONFIG_FILE" ]; then
        printf '%s' "$defaults"
        return 0
    fi
    local ondisk
    ondisk=$(jq -e '.' "$CONFIG_FILE" 2>/dev/null) || true
    if [ -z "$ondisk" ]; then
        log "WARN: config.json malformed, using defaults"
        printf '%s' "$defaults"
        return 0
    fi
    # Merge: on-disk overrides defaults for present keys
    jq -s '.[0] * .[1]' <(printf '%s' "$defaults") <(printf '%s' "$ondisk")
}

# ─── Pattern matching ────────────────────────────────────────────────────────

# Adapt pattern for \w compatibility if needed
adapt_pattern() {
    local pat="$1"
    if [ "$USE_WORD_CLASS" -eq 0 ]; then
        # Replace \w with [[:alnum:]_]
        pat=$(printf '%s' "$pat" | sed 's/\\w/[[:alnum:]_]/g')
    fi
    printf '%s' "$pat"
}

# Validate a regex pattern. Returns 0 if valid, 1 if not.
validate_pattern() {
    printf '' | grep -Eq "$1" 2>/dev/null
    # grep returns 1 on no-match which is fine; only 2 means error
    local rc=$?
    [ "$rc" -ne 2 ]
}

# Compile patterns for a given kind (exit, issues_fixed, trigger).
# Reads defaults + config, applies mode (default/extend/replace), validates.
# Prints one pattern per line.
compile_pattern_list() {
    local kind="$1"
    local config
    config=$(read_config)

    local mode custom_json defaults_text
    case "$kind" in
        exit)
            mode=$(jq -r '.exit_patterns_mode // "default"' <<<"$config")
            custom_json=$(jq -r '.custom_exit_patterns // []' <<<"$config")
            defaults_text=$(get_exit_patterns)
            ;;
        issues_fixed)
            mode=$(jq -r '.issues_fixed_patterns_mode // "default"' <<<"$config")
            custom_json=$(jq -r '.custom_issues_fixed_patterns // []' <<<"$config")
            defaults_text=$(get_issues_fixed_patterns)
            ;;
        trigger)
            mode="extend"  # triggers always extend
            custom_json=$(jq -r '.custom_trigger_patterns // []' <<<"$config")
            defaults_text=$(get_trigger_patterns)
            ;;
        *)
            return 1
            ;;
    esac

    local patterns=""
    case "$mode" in
        replace)
            # Only custom patterns
            patterns=$(jq -r '.[]' <<<"$custom_json" 2>/dev/null || true)
            ;;
        extend)
            patterns="$defaults_text"
            local custom_list
            custom_list=$(jq -r '.[]' <<<"$custom_json" 2>/dev/null || true)
            if [ -n "$custom_list" ]; then
                patterns="$patterns"$'\n'"$custom_list"
            fi
            ;;
        *)  # default
            patterns="$defaults_text"
            ;;
    esac

    # Validate each pattern (skip PCRE: prefix lines for validation — they
    # use a different engine)
    while IFS= read -r pat; do
        [ -z "$pat" ] && continue
        if [[ "$pat" == PCRE:* ]]; then
            printf '%s\n' "$pat"
            continue
        fi
        local adapted
        adapted=$(adapt_pattern "$pat")
        if validate_pattern "$adapted"; then
            printf '%s\n' "$adapted"
        else
            log "WARN: invalid pattern skipped: $pat"
        fi
    done <<<"$patterns"
}

# Match text against a set of patterns. Returns 0 if any pattern matches.
match_patterns() {
    local text="$1" kind="$2"
    local patterns
    patterns=$(compile_pattern_list "$kind")

    while IFS= read -r pat; do
        [ -z "$pat" ] && continue

        if [[ "$pat" == PCRE:* ]]; then
            local pcre_pat="${pat#PCRE:}"
            pcre_pat=$(adapt_pattern "$pcre_pat")
            if [ -n "$GREP_P" ]; then
                if printf '%s' "$text" | $GREP_P -iq "$pcre_pat" 2>/dev/null; then
                    return 0
                fi
            else
                # Fallback: two-pass. Sanitize "no issues/problems/bugs" then
                # match the bare pattern without the lookbehind.
                local sanitized bare_pat
                # Lowercase first: macOS BSD sed lacks the i flag for
                # case-insensitive matching; \+ is also GNU-only (use +
                # with -E instead).
                sanitized=$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]' | sed -E 's/no[[:space:]]+issues/__EXCLUDED__/g; s/no[[:space:]]+problems/__EXCLUDED__/g; s/no[[:space:]]+bugs/__EXCLUDED__/g')
                # Strip the lookbehind from the pattern
                bare_pat=$(printf '%s' "$pcre_pat" | sed 's/(?<![^)]*)//')
                bare_pat=$(adapt_pattern "$bare_pat")
                if printf '%s' "$sanitized" | grep -Eiq "$bare_pat" 2>/dev/null; then
                    return 0
                fi
            fi
            continue
        fi

        if printf '%s' "$text" | grep -Eiq "$pat" 2>/dev/null; then
            return 0
        fi
    done <<<"$patterns"

    return 1
}

matches_exit() { match_patterns "$1" "exit"; }
matches_issues_fixed() { match_patterns "$1" "issues_fixed"; }
matches_trigger() { match_patterns "$1" "trigger"; }

# ─── Prompt building ─────────────────────────────────────────────────────────

build_prompt() {
    local kind="$1" focus="$2"
    local config override file content
    config=$(read_config)

    # Config override: .prompt_code or .prompt_plan
    override=$(jq -r ".prompt_$kind // empty" <<<"$config")

    if [ -n "$override" ]; then
        case "$override" in
            '~/'*)  file="$HOME/${override#\~/}" ;;
            *)      file="$override" ;;
        esac
    else
        file="$PROMPTS_DIR/$kind.md"
    fi

    if [ ! -r "$file" ]; then
        log "ERROR: prompt file not readable: $file"
        return 1
    fi

    # One awk pass: strip YAML frontmatter (only if --- is at line 1),
    # trim leading blank lines, buffer for trailing blank trim.
    # Then sed strips pi's $@ placeholder.
    content=$(awk '
        NR == 1 && /^---$/ { skip = 1; next }
        skip && /^---$/    { skip = 0; next }
        skip              { next }
        /^[[:space:]]*$/ && !started { next }
        { started = 1; buf[++n] = $0 }
        END {
            last = n
            while (last > 0 && buf[last] ~ /^[[:space:]]*$/) last--
            for (i = 1; i <= last; i++) print buf[i]
        }
    ' "$file" | sed 's/\$@//g')

    if [ -n "$focus" ]; then
        printf '%s\n\n**Additional focus:** %s\n' "$content" "$focus"
    else
        printf '%s\n' "$content"
    fi
    return 0
}

# ─── Transcript parsing ─────────────────────────────────────────────────────

read_last_assistant_text() {
    local transcript_path="$1"
    if [ ! -f "$transcript_path" ]; then
        return 0
    fi

    # Walk backward through transcript, up to 500 lines
    local reversed
    reversed=$(eval "$REVERSE" < "$transcript_path" | head -500)

    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local text
        text=$(jq -r '
            select(.type == "assistant")
            | (.message.content // [])
            | map(select(.type == "text") | .text)
            | join("\n")
        ' <<<"$line" 2>/dev/null) || continue

        if [ -n "$text" ] && [ "$text" != "null" ]; then
            printf '%s' "$text"
            return 0
        fi
    done <<<"$reversed"

    return 0
}

# ─── Session ID resolution ───────────────────────────────────────────────────

resolve_session_id() {
    # Primary: scan pending files for cwd match
    local best_sid="" best_ts=0
    local pending_file
    for pending_file in "$STATE_DIR"/pending-*.json; do
        [ -f "$pending_file" ] || continue
        local pdata
        pdata=$(jq -e '.' "$pending_file" 2>/dev/null) || continue
        local pcwd pts psid
        pcwd=$(jq -r '.cwd // ""' <<<"$pdata")
        pts=$(jq -r '.created_at // 0' <<<"$pdata")
        psid=$(jq -r '.session_id // ""' <<<"$pdata")

        # TTL check: 5 minutes
        local now
        now=$(date +%s)
        if [ "$((now - pts))" -gt 300 ]; then
            continue
        fi

        if [ "$pcwd" = "$PWD" ] && [ "$pts" -gt "$best_ts" ]; then
            best_sid="$psid"
            best_ts="$pts"
        fi
    done

    if [ -n "$best_sid" ]; then
        printf '%s' "$best_sid"
        return 0
    fi

    # Fallback: scan ~/.claude/projects/ for transcript with matching cwd
    local projects_dir="$HOME/.claude/projects"
    if [ -d "$projects_dir" ]; then
        local proj_dir
        for proj_dir in "$projects_dir"/*/; do
            [ -d "$proj_dir" ] || continue
            # Find most recent .jsonl file
            local transcript
            transcript=$(ls -t "$proj_dir"*.jsonl 2>/dev/null | head -1)
            [ -n "$transcript" ] && [ -f "$transcript" ] || continue

            # Extract cwd from transcript events
            local tcwd
            tcwd=$(head -20 "$transcript" | jq -r 'select(.cwd != null) | .cwd' 2>/dev/null | head -1)
            if [ "$tcwd" = "$PWD" ]; then
                # Use transcript filename stem as session_id
                local stem
                stem=$(basename "$transcript" .jsonl)
                printf '%s' "$stem"
                return 0
            fi
        done
    fi

    echo "Cannot determine current Claude Code session." >&2
    echo "Run this from inside a \`claude\` session so UserPromptSubmit can capture the session_id," >&2
    echo "or create ~/.claude/review-loop/pending-<session>.json manually." >&2
    return 1
}

# ─── Activation core ─────────────────────────────────────────────────────────

activate_core() {
    local sid="$1" cwd="$2" kind="$3" focus="$4"
    local now existing new_state
    now=$(date +%s)
    existing=$(read_state "$sid")

    if [ -z "$existing" ]; then
        # Fresh activation
        new_state=$(jq -n \
            --arg sid "$sid" \
            --arg cwd "$cwd" \
            --arg kind "$kind" \
            --arg focus "$focus" \
            --argjson now "$now" \
            '{
                active: true,
                paused: false,
                iteration: 0,
                kind: $kind,
                focus: $focus,
                session_id: $sid,
                cwd: $cwd,
                started_at: $now,
                last_updated: $now,
                last_block_at: 0,
                last_block_reason: ""
            }')
    else
        # Update existing: clear paused, update kind/cwd, update focus only
        # if non-empty (empty focus from auto-trigger must not wipe explicit focus)
        new_state=$(jq \
            --arg kind "$kind" \
            --arg focus "$focus" \
            --arg cwd "$cwd" \
            --argjson now "$now" \
            '.active = true
             | .paused = false
             | .kind = $kind
             | .cwd = $cwd
             | (if $focus != "" then .focus = $focus else . end)
             | .last_updated = $now' \
            <<<"$existing")
    fi

    if ! write_state "$sid" "$new_state"; then
        log "ERROR session $sid: activate_core write failed"
        return 1
    fi
    return 0
}

# ─── Subcommands ─────────────────────────────────────────────────────────────

cmd_activate() {
    local sid="$1" kind="$2" focus="${3:-}"

    case "$kind" in
        code|plan) ;;
        *) echo "ERROR: kind must be 'code' or 'plan', got: $kind" >&2
           exit 2 ;;
    esac

    # Focus resolution: env var takes precedence, then pending.focus fallback
    if [ -z "$focus" ]; then
        local pending
        pending=$(read_pending "$sid")
        if [ -n "$pending" ]; then
            focus=$(jq -r '.focus // ""' <<<"$pending")
        fi
    fi

    if ! activate_core "$sid" "$PWD" "$kind" "$focus"; then
        echo "ERROR: activation failed. Check ~/.claude/review-loop/hook.log for details." >&2
        exit 1
    fi

    if ! build_prompt "$kind" "$focus"; then
        echo "ERROR: could not build review prompt. Check prompts directory." >&2
        exit 1
    fi
}

cmd_deactivate() {
    local sid="$1"
    local state
    state=$(read_state "$sid")
    if [ -z "$state" ]; then
        echo "Review loop is not active for this session."
        return 0
    fi
    delete_state "$sid"
    log "session $sid: deactivated by user"
    echo "Review loop stopped."
}

cmd_pause() {
    local sid="$1"
    local state
    state=$(read_state "$sid")
    if [ -z "$state" ]; then
        echo "Review loop is not active for this session."
        return 0
    fi
    if [ "$(jq -r '.paused' <<<"$state")" = true ]; then
        echo "Review loop is already paused."
        return 0
    fi
    if ! set_paused "$sid" true; then
        echo "ERROR: could not pause." >&2
        exit 1
    fi
    log "session $sid: paused by user"
    echo "Review loop paused. Use /review-resume to continue."
}

cmd_resume() {
    local sid="$1"
    local state
    state=$(read_state "$sid")

    if [ -z "$state" ]; then
        echo "Review loop is not active for this session."
        return 0
    fi

    if [ "$(jq -r '.paused' <<<"$state")" != true ]; then
        echo "Review loop is already running (not paused)."
        return 0
    fi

    if ! set_paused "$sid" false; then
        echo "ERROR: could not clear paused state." >&2
        exit 1
    fi

    local kind focus
    kind=$(jq -r '.kind' <<<"$state")
    focus=$(jq -r '.focus // ""' <<<"$state")
    if ! build_prompt "$kind" "$focus"; then
        echo "ERROR: could not build review prompt." >&2
        exit 1
    fi
}

cmd_status() {
    local sid="$1"
    local state config
    state=$(read_state "$sid")
    config=$(read_config)

    if [ -z "$state" ]; then
        echo "Review loop: inactive"
        echo ""
        echo "Config:"
        echo "  max_iterations: $(jq -r '.max_iterations' <<<"$config")"
        echo "  auto_trigger:   $(jq -r '.auto_trigger' <<<"$config")"
        echo "  interrupt:      $(jq -r '.interrupt_behavior' <<<"$config")"
        return 0
    fi

    local active paused iteration kind focus max cwd
    active=$(jq -r '.active' <<<"$state")
    paused=$(jq -r '.paused' <<<"$state")
    iteration=$(jq -r '.iteration' <<<"$state")
    kind=$(jq -r '.kind' <<<"$state")
    focus=$(jq -r '.focus // ""' <<<"$state")
    max=$(jq -r '.max_iterations' <<<"$config")
    cwd=$(jq -r '.cwd // ""' <<<"$state")

    echo "Review loop: active"
    echo "  kind:       $kind"
    echo "  iteration:  $iteration / $max"
    echo "  paused:     $paused"
    if [ -n "$focus" ]; then
        echo "  focus:      $focus"
    fi
    echo "  cwd:        $cwd"
    echo "  session:    $sid"
    echo ""
    echo "Config:"
    echo "  max_iterations: $max"
    echo "  auto_trigger:   $(jq -r '.auto_trigger' <<<"$config")"
    echo "  interrupt:      $(jq -r '.interrupt_behavior' <<<"$config")"
}

cmd_max() {
    local n="$1"
    if [ -z "$n" ] || ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -lt 1 ]; then
        echo "Usage: hook.sh max <N> (positive integer)" >&2
        exit 2
    fi
    local config tmp
    config=$(read_config)
    tmp="${CONFIG_FILE}.tmp.$$"
    jq --argjson n "$n" '.max_iterations = $n' <<<"$config" > "$tmp" \
        && mv "$tmp" "$CONFIG_FILE"
    echo "Max iterations set to $n."
}

cmd_auto() {
    local arg="${1:-toggle}"
    local config current new_val tmp
    config=$(read_config)
    current=$(jq -r '.auto_trigger' <<<"$config")

    case "$arg" in
        on)     new_val=true ;;
        off)    new_val=false ;;
        toggle)
            if [ "$current" = "true" ]; then
                new_val=false
            else
                new_val=true
            fi
            ;;
        *)
            echo "Usage: hook.sh auto <on|off|toggle>" >&2
            exit 2
            ;;
    esac

    tmp="${CONFIG_FILE}.tmp.$$"
    jq --argjson v "$new_val" '.auto_trigger = $v' <<<"$config" > "$tmp" \
        && mv "$tmp" "$CONFIG_FILE"
    echo "Auto-trigger: $new_val"
}

cmd_interrupt() {
    local arg="$1"
    case "$arg" in
        pause|stop) ;;
        *)
            echo "Usage: hook.sh interrupt <pause|stop>" >&2
            exit 2
            ;;
    esac
    local config tmp
    config=$(read_config)
    tmp="${CONFIG_FILE}.tmp.$$"
    jq --arg v "$arg" '.interrupt_behavior = $v' <<<"$config" > "$tmp" \
        && mv "$tmp" "$CONFIG_FILE"
    echo "Interrupt behavior set to: $arg"
}

# ─── Hook handlers ───────────────────────────────────────────────────────────

handle_stop() {
    local input="$1"
    local input_session input_cwd input_transcript
    input_session=$(jq -r '.session_id' <<<"$input")
    input_cwd=$(jq -r '.cwd' <<<"$input")
    input_transcript=$(jq -r '.transcript_path' <<<"$input")

    # 1. Auto-trigger promotion
    local pending
    pending=$(read_pending "$input_session")
    if [ -n "$pending" ] && [ "$(jq -r '.delayed' <<<"$pending")" = "true" ]; then
        local existing_state
        existing_state=$(read_state "$input_session")
        if [ -z "$existing_state" ] || [ "$(jq -r '.active' <<<"$existing_state")" != "true" ]; then
            local pending_kind
            pending_kind=$(jq -r '.kind' <<<"$pending")
            case "$pending_kind" in
                code|plan) ;;
                *) log "WARN session $input_session: invalid kind '$pending_kind' in pending, defaulting to code"
                   pending_kind=code ;;
            esac
            activate_core "$input_session" "$input_cwd" "$pending_kind" "" \
                || log "ERROR session $input_session: activate_core failed during auto-trigger promotion"
        fi
        delete_pending "$input_session"
    fi

    # 2. Load state
    local state
    state=$(read_state "$input_session")
    if [ -z "$state" ]; then
        exit 0
    fi

    # 3. Guards
    if [ "$(jq -r '.active' <<<"$state")" != "true" ]; then exit 0; fi
    if [ "$(jq -r '.paused' <<<"$state")" = "true" ]; then
        log "session $input_session: paused, allowing stop"
        exit 0
    fi
    if [ "$(jq -r '.session_id' <<<"$state")" != "$input_session" ]; then
        log "session $input_session: state file mismatch, allowing stop"
        exit 0
    fi

    # 4. Extract last assistant text
    local text
    text=$(read_last_assistant_text "$input_transcript")

    # 5. Empty text → pause
    if [ -z "$text" ]; then
        log "session $input_session: empty assistant text, pausing loop"
        if ! set_paused "$input_session" true; then
            log "ERROR session $input_session: set_paused failed, deleting state"
            delete_state "$input_session"
        fi
        exit 0
    fi

    # 6. Termination: exit phrase AND NOT issues-fixed
    if matches_exit "$text" && ! matches_issues_fixed "$text"; then
        delete_state "$input_session"
        log "session $input_session: deactivated (no issues found)"
        exit 0
    fi

    # 7. Increment iteration, check max
    local config max iter new_iter
    config=$(read_config)
    max=$(jq -r '.max_iterations' <<<"$config")
    iter=$(jq -r '.iteration' <<<"$state")
    new_iter=$((iter + 1))

    if [ "$new_iter" -ge "$max" ]; then
        delete_state "$input_session"
        log "session $input_session: deactivated (max iterations, pass $new_iter >= $max)"
        exit 0
    fi

    # 8. Build prompt, persist state, emit block
    local kind focus prompt
    kind=$(jq -r '.kind' <<<"$state")
    focus=$(jq -r '.focus // ""' <<<"$state")
    if ! prompt=$(build_prompt "$kind" "$focus"); then
        log "ERROR session $input_session: build_prompt failed, pausing loop"
        if ! set_paused "$input_session" true; then
            log "ERROR session $input_session: set_paused also failed, deleting state"
            delete_state "$input_session"
        fi
        exit 0
    fi

    local now new_state
    now=$(date +%s)
    new_state=$(jq \
        --argjson iter "$new_iter" \
        --argjson now "$now" \
        --arg reason "$prompt" \
        '.iteration = $iter
         | .last_updated = $now
         | .last_block_at = $now
         | .last_block_reason = $reason' \
        <<<"$state")

    # 9. Persist with error handling
    if ! write_state "$input_session" "$new_state"; then
        log "ERROR session $input_session: state write failed at iter $new_iter, aborting loop"
        delete_state "$input_session"
        exit 0
    fi

    log "session $input_session: iter $new_iter/$max → block"
    jq -n --arg reason "$prompt" '{decision: "block", reason: $reason}'
    exit 0
}

handle_user_prompt() {
    local input="$1"
    local input_session input_cwd input_prompt
    input_session=$(jq -r '.session_id' <<<"$input")
    input_cwd=$(jq -r '.cwd' <<<"$input")
    input_prompt=$(jq -r '.prompt // empty' <<<"$input")

    local state config
    state=$(read_state "$input_session")
    config=$(read_config)

    # 2. Control-command pre-capture (before Case B mitigation)
    if [[ "$input_prompt" =~ ^/review- ]]; then
        local parsed_focus="" parsed_kind=""
        local normalized
        normalized=$(printf '%s' "$input_prompt" | tr '\n\r' '  ')
        case "$normalized" in
            "/review-start"|"/review-start "*)
                parsed_kind="code"
                parsed_focus=$(printf '%s' "$normalized" | sed -E 's|^/review-start[[:space:]]*||; s|[[:space:]]+$||')
                ;;
            "/review-plan"|"/review-plan "*)
                parsed_kind="plan"
                parsed_focus=$(printf '%s' "$normalized" | sed -E 's|^/review-plan[[:space:]]*||; s|[[:space:]]+$||')
                ;;
        esac
        write_pending "$input_session" "$input_cwd" false "$parsed_kind" "$parsed_focus"
        exit 0
    fi

    # 3. Case B mitigation: detect forced continuations
    if [ -n "$state" ]; then
        local last_reason last_block now
        last_reason=$(jq -r '.last_block_reason // ""' <<<"$state")
        last_block=$(jq -r '.last_block_at // 0' <<<"$state")
        now=$(date +%s)

        if [ -n "$last_reason" ] && [ "$input_prompt" = "$last_reason" ]; then
            log "session $input_session: UserPromptSubmit matches last_block_reason, forced continuation"
            exit 0
        fi
        if [ "$((now - last_block))" -lt 2 ]; then
            log "session $input_session: UserPromptSubmit within 2s of last block, treating as forced continuation"
            exit 0
        fi
    fi

    # 4. Auto-trigger
    local auto_trigger_enabled
    auto_trigger_enabled=$(jq -r '.auto_trigger // false' <<<"$config")
    if [ "$auto_trigger_enabled" = "true" ] && [ -z "$state" ]; then
        if matches_trigger "$input_prompt"; then
            write_pending "$input_session" "$input_cwd" true "code"
            echo "[INTERNAL NOTE, do not mention in reply: Review loop will auto-activate after this response. Complete the user's request first; a review pass will begin automatically.]"
            exit 0
        fi
    fi

    # 5. Interrupt handling
    if [ -n "$state" ] && [ "$(jq -r '.active' <<<"$state")" = "true" ]; then
        # Skip interrupt if trigger match while auto_trigger is on
        if [ "$auto_trigger_enabled" = "true" ] && matches_trigger "$input_prompt"; then
            log "session $input_session: trigger match while active, skipping interrupt"
            exit 0
        fi

        local behavior
        behavior=$(jq -r '.interrupt_behavior // "pause"' <<<"$config")
        case "$behavior" in
            pause)
                if ! set_paused "$input_session" true; then
                    log "ERROR session $input_session: set_paused failed during interrupt, deleting state"
                    delete_state "$input_session"
                else
                    log "session $input_session: interrupt → paused"
                fi
                ;;
            stop)
                delete_state "$input_session"
                log "session $input_session: interrupt → stopped"
                ;;
        esac
    fi

    exit 0
}

# ─── Selftest ────────────────────────────────────────────────────────────────

cmd_selftest() {
    # Use a non-local variable so the EXIT trap can reference it after
    # cmd_selftest returns (local vars go out of scope).
    _SELFTEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/rl-selftest-XXXXXX")
    trap 'rm -rf "$_SELFTEST_TMPDIR"' EXIT
    local TMPDIR_ST="$_SELFTEST_TMPDIR"

    export REVIEW_LOOP_STATE_DIR_OVERRIDE="$TMPDIR_ST"
    STATE_DIR="$TMPDIR_ST"
    CONFIG_FILE="$STATE_DIR/config.json"
    PROMPTS_DIR="$STATE_DIR/prompts"
    LOG_FILE="$STATE_DIR/hook.log"

    # Setup: prompts directory with real prompts
    mkdir -p "$TMPDIR_ST/prompts"
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$script_dir/prompts/code.md" ]; then
        ln -s "$script_dir/prompts/code.md" "$TMPDIR_ST/prompts/code.md"
        ln -s "$script_dir/prompts/plan.md" "$TMPDIR_ST/prompts/plan.md"
    else
        # Fallback: write minimal prompt files
        printf '%s\n' "---" "description: test" "---" "Review the code." > "$TMPDIR_ST/prompts/code.md"
        printf '%s\n' "---" "description: test" "---" "Review the plan." > "$TMPDIR_ST/prompts/plan.md"
    fi

    # Default config — write defaults directly; can't use read_config > file
    # because the redirect creates an empty file before read_config runs.
    local cfg_defaults
    cfg_defaults=$(read_config)
    printf '%s\n' "$cfg_defaults" > "$CONFIG_FILE"

    local pass=0 fail=0 total=0

    assert() {
        total=$((total + 1))
        local desc="$1"
        shift
        if "$@"; then
            pass=$((pass + 1))
        else
            fail=$((fail + 1))
            echo "  FAIL: $desc"
        fi
    }

    assert_file_exists() { assert "$1 exists" test -f "$2"; }
    assert_file_missing() { assert "$1 missing" test ! -f "$2"; }

    # Helper: create a canned transcript with assistant text
    make_transcript() {
        local file="$1" text="$2"
        printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$text" > "$file"
    }

    echo "Running selftest..."
    echo ""

    # --- Test: Stop hook with no state → allow stop ---
    local output
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-1","cwd":"/tmp","transcript_path":"/dev/null"}') 2>/dev/null) || true
    assert "Stop with no state → no output" test -z "$output"

    # --- Test: activate + Stop with exit phrase → deactivate ---
    activate_core "test-2" "/tmp" "code" ""
    make_transcript "$TMPDIR_ST/transcript-2.jsonl" "I reviewed everything. No issues found."
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-2","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-2.jsonl"}') 2>/dev/null) || true
    assert "Stop with exit phrase → no output (allow stop)" test -z "$output"
    assert_file_missing "state deleted after exit phrase" "$TMPDIR_ST/state-test-2.json"

    # --- Test: activate + Stop with exit phrase + issues fixed → block (continue) ---
    activate_core "test-3" "/tmp" "code" ""
    make_transcript "$TMPDIR_ST/transcript-3.jsonl" "I fixed 3 issues. No issues found."
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-3","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-3.jsonl"}') 2>/dev/null) || true
    assert "Stop with exit+issues-fixed → block emitted" echo "$output" | jq -e '.decision == "block"' >/dev/null 2>&1
    assert_file_exists "state preserved after issues-fixed" "$TMPDIR_ST/state-test-3.json"
    local iter3
    iter3=$(jq -r '.iteration' "$TMPDIR_ST/state-test-3.json")
    assert "iteration incremented to 1" test "$iter3" -eq 1

    # --- Test: Stop at max iterations → deactivate ---
    # Set iteration to 6, max is 7, so new_iter=7 >= 7 → stop
    jq '.iteration = 6' "$TMPDIR_ST/state-test-3.json" > "$TMPDIR_ST/state-test-3.json.tmp" \
        && mv "$TMPDIR_ST/state-test-3.json.tmp" "$TMPDIR_ST/state-test-3.json"
    make_transcript "$TMPDIR_ST/transcript-3b.jsonl" "Still reviewing, found some stuff."
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-3","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-3b.jsonl"}') 2>/dev/null) || true
    assert "Stop at max → no output" test -z "$output"
    assert_file_missing "state deleted at max" "$TMPDIR_ST/state-test-3.json"

    # --- Test: Stop with empty text → pause ---
    activate_core "test-4" "/tmp" "code" ""
    printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}\n' > "$TMPDIR_ST/transcript-4.jsonl"
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-4","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-4.jsonl"}') 2>/dev/null) || true
    assert "Stop with empty text → no output" test -z "$output"
    local paused4
    paused4=$(jq -r '.paused' "$TMPDIR_ST/state-test-4.json" 2>/dev/null)
    assert "state paused on empty text" test "$paused4" = "true"

    # --- Test: Stop with different cwd → still blocks (no cwd check) ---
    activate_core "test-5" "/different/dir" "code" ""
    make_transcript "$TMPDIR_ST/transcript-5.jsonl" "Still looking at the code..."
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-5","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-5.jsonl"}') 2>/dev/null) || true
    assert "Stop with cwd mismatch → still blocks" echo "$output" | jq -e '.decision == "block"' >/dev/null 2>&1

    # --- Test: Auto-trigger promotion ---
    write_pending "test-6" "/tmp" true "code"
    make_transcript "$TMPDIR_ST/transcript-6.jsonl" "Done implementing the plan."
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-6","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-6.jsonl"}') 2>/dev/null) || true
    assert "Auto-trigger → block emitted" echo "$output" | jq -e '.decision == "block"' >/dev/null 2>&1
    assert_file_exists "state created by promotion" "$TMPDIR_ST/state-test-6.json"
    assert_file_missing "pending deleted after promotion" "$TMPDIR_ST/pending-test-6.json"

    # --- Test: Auto-trigger with invalid kind → defaults to code ---
    local bad_pending_file="$TMPDIR_ST/pending-test-6b.json"
    jq -n --argjson now "$(date +%s)" '{"session_id":"test-6b","cwd":"/tmp","created_at":$now,"delayed":true,"kind":"xyz","focus":""}' > "$bad_pending_file"
    make_transcript "$TMPDIR_ST/transcript-6b.jsonl" "Done."
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-6b","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-6b.jsonl"}') 2>/dev/null) || true
    local kind6b
    kind6b=$(jq -r '.kind' "$TMPDIR_ST/state-test-6b.json" 2>/dev/null)
    assert "Invalid pending kind defaults to code" test "$kind6b" = "code"

    # --- Test: UserPromptSubmit /review-start with focus ---
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-7","cwd":"/tmp","prompt":"/review-start focus on error handling"}') 2>/dev/null) || true
    assert "UPS /review-start → no output" test -z "$output"
    local pfocus7
    pfocus7=$(jq -r '.focus' "$TMPDIR_ST/pending-test-7.json" 2>/dev/null)
    assert "pending focus parsed" test "$pfocus7" = "focus on error handling"
    local pkind7
    pkind7=$(jq -r '.kind' "$TMPDIR_ST/pending-test-7.json" 2>/dev/null)
    assert "pending kind=code" test "$pkind7" = "code"

    # --- Test: UserPromptSubmit /review-start without focus ---
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-7b","cwd":"/tmp","prompt":"/review-start"}') 2>/dev/null) || true
    local pfocus7b
    pfocus7b=$(jq -r '.focus' "$TMPDIR_ST/pending-test-7b.json" 2>/dev/null)
    assert "pending focus empty when no focus given" test "$pfocus7b" = ""

    # --- Test: UserPromptSubmit /review-plan with focus ---
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-7c","cwd":"/tmp","prompt":"/review-plan check the architecture"}') 2>/dev/null) || true
    local pkind7c
    pkind7c=$(jq -r '.kind' "$TMPDIR_ST/pending-test-7c.json" 2>/dev/null)
    assert "pending kind=plan for /review-plan" test "$pkind7c" = "plan"

    # --- Test: UserPromptSubmit /review-start-xyz is NOT /review-start ---
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-7d","cwd":"/tmp","prompt":"/review-start-xyz"}') 2>/dev/null) || true
    local pkind7d
    pkind7d=$(jq -r '.kind' "$TMPDIR_ST/pending-test-7d.json" 2>/dev/null)
    assert "/review-start-xyz kind is empty (not code)" test "$pkind7d" = ""

    # --- Test: UserPromptSubmit with newline in prompt ---
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-7e","cwd":"/tmp","prompt":"/review-plan\nmore text"}') 2>/dev/null) || true
    local pfocus7e
    pfocus7e=$(jq -r '.focus' "$TMPDIR_ST/pending-test-7e.json" 2>/dev/null)
    assert "/review-plan with newline: focus parsed" test "$pfocus7e" = "more text"

    # --- Test: Case B content mitigation ---
    activate_core "test-8" "/tmp" "code" ""
    local reason8="Great, now I want you to carefully read over all of the new code..."
    jq --arg r "$reason8" --argjson now "$(date +%s)" \
        '.last_block_reason = $r | .last_block_at = $now' \
        "$TMPDIR_ST/state-test-8.json" > "$TMPDIR_ST/state-test-8.json.tmp" \
        && mv "$TMPDIR_ST/state-test-8.json.tmp" "$TMPDIR_ST/state-test-8.json"
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-8","cwd":"/tmp","prompt":"'"$reason8"'"}') 2>/dev/null) || true
    local paused8
    paused8=$(jq -r '.paused' "$TMPDIR_ST/state-test-8.json" 2>/dev/null)
    assert "Case B content match → not paused (forced continuation skip)" test "$paused8" = "false"

    # --- Test: Case B time mitigation ---
    activate_core "test-8b" "/tmp" "code" ""
    local now_ts
    now_ts=$(date +%s)
    jq --arg r "something else" --argjson now "$now_ts" \
        '.last_block_reason = $r | .last_block_at = $now' \
        "$TMPDIR_ST/state-test-8b.json" > "$TMPDIR_ST/state-test-8b.json.tmp" \
        && mv "$TMPDIR_ST/state-test-8b.json.tmp" "$TMPDIR_ST/state-test-8b.json"
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-8b","cwd":"/tmp","prompt":"different prompt"}') 2>/dev/null) || true
    local paused8b
    paused8b=$(jq -r '.paused' "$TMPDIR_ST/state-test-8b.json" 2>/dev/null)
    assert "Case B time check → not paused (forced continuation skip)" test "$paused8b" = "false"

    # --- Test: Interrupt → pause (default) ---
    activate_core "test-9" "/tmp" "code" ""
    # Set last_block_at to far past so it's not caught by Case B
    jq '.last_block_at = 0 | .last_block_reason = ""' \
        "$TMPDIR_ST/state-test-9.json" > "$TMPDIR_ST/state-test-9.json.tmp" \
        && mv "$TMPDIR_ST/state-test-9.json.tmp" "$TMPDIR_ST/state-test-9.json"
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-9","cwd":"/tmp","prompt":"Actually focus on auth"}') 2>/dev/null) || true
    local paused9
    paused9=$(jq -r '.paused' "$TMPDIR_ST/state-test-9.json" 2>/dev/null)
    assert "Interrupt default → paused" test "$paused9" = "true"

    # --- Test: Interrupt → stop ---
    activate_core "test-9b" "/tmp" "code" ""
    jq '.last_block_at = 0 | .last_block_reason = ""' \
        "$TMPDIR_ST/state-test-9b.json" > "$TMPDIR_ST/state-test-9b.json.tmp" \
        && mv "$TMPDIR_ST/state-test-9b.json.tmp" "$TMPDIR_ST/state-test-9b.json"
    jq '.interrupt_behavior = "stop"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" \
        && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-9b","cwd":"/tmp","prompt":"Lets do something else"}') 2>/dev/null) || true
    assert_file_missing "state deleted on interrupt=stop" "$TMPDIR_ST/state-test-9b.json"
    # Reset config
    jq '.interrupt_behavior = "pause"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" \
        && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    # --- Test: Auto-trigger ---
    jq '.auto_trigger = true' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" \
        && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-10","cwd":"/tmp","prompt":"Great, now implement the plan"}') 2>/dev/null) || true
    assert "Auto-trigger → notice printed" echo "$output" | grep -q "INTERNAL NOTE"
    assert_file_exists "delayed pending created" "$TMPDIR_ST/pending-test-10.json"
    local delayed10
    delayed10=$(jq -r '.delayed' "$TMPDIR_ST/pending-test-10.json" 2>/dev/null)
    assert "pending is delayed" test "$delayed10" = "true"
    # Reset config
    jq '.auto_trigger = false' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" \
        && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    # --- Test: Trigger match while active + auto_trigger → skip interrupt ---
    jq '.auto_trigger = true' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" \
        && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    activate_core "test-10b" "/tmp" "code" ""
    jq '.last_block_at = 0 | .last_block_reason = ""' \
        "$TMPDIR_ST/state-test-10b.json" > "$TMPDIR_ST/state-test-10b.json.tmp" \
        && mv "$TMPDIR_ST/state-test-10b.json.tmp" "$TMPDIR_ST/state-test-10b.json"
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-10b","cwd":"/tmp","prompt":"Now implement the plan"}') 2>/dev/null) || true
    local paused10b
    paused10b=$(jq -r '.paused' "$TMPDIR_ST/state-test-10b.json" 2>/dev/null)
    assert "Trigger while active + auto → not paused" test "$paused10b" = "false"
    jq '.auto_trigger = false' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" \
        && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    # --- Test: Trigger match while active + auto_trigger OFF → interrupt ---
    activate_core "test-10c" "/tmp" "code" ""
    jq '.last_block_at = 0 | .last_block_reason = ""' \
        "$TMPDIR_ST/state-test-10c.json" > "$TMPDIR_ST/state-test-10c.json.tmp" \
        && mv "$TMPDIR_ST/state-test-10c.json.tmp" "$TMPDIR_ST/state-test-10c.json"
    output=$( (handle_user_prompt '{"hook_event_name":"UserPromptSubmit","session_id":"test-10c","cwd":"/tmp","prompt":"Now implement the plan"}') 2>/dev/null) || true
    local paused10c
    paused10c=$(jq -r '.paused' "$TMPDIR_ST/state-test-10c.json" 2>/dev/null)
    assert "Trigger while active + auto OFF → paused" test "$paused10c" = "true"

    # --- Test: cmd_activate focus fallback from pending ---
    write_pending "test-11" "/tmp" false "code" "focus on security"
    activate_core "test-11" "/tmp" "code" ""
    # Now test that cmd_activate reads pending focus
    rm -f "$TMPDIR_ST/state-test-11.json"
    write_pending "test-11" "$PWD" false "code" "focus on security"
    (cd /tmp && cmd_activate "test-11" "code" "") >/dev/null 2>&1 || true
    local focus11
    focus11=$(jq -r '.focus' "$TMPDIR_ST/state-test-11.json" 2>/dev/null)
    assert "cmd_activate fallback to pending focus" test "$focus11" = "focus on security"

    # --- Test: cmd_activate env var takes precedence ---
    rm -f "$TMPDIR_ST/state-test-11.json"
    write_pending "test-11" "$PWD" false "code" "from pending"
    (cd /tmp && cmd_activate "test-11" "code" "from env var") >/dev/null 2>&1 || true
    local focus11b
    focus11b=$(jq -r '.focus' "$TMPDIR_ST/state-test-11.json" 2>/dev/null)
    assert "cmd_activate env var takes precedence" test "$focus11b" = "from env var"

    # --- Test: activate preserves iteration ---
    activate_core "test-12" "/tmp" "code" "initial focus"
    jq '.iteration = 3' "$TMPDIR_ST/state-test-12.json" > "$TMPDIR_ST/state-test-12.json.tmp" \
        && mv "$TMPDIR_ST/state-test-12.json.tmp" "$TMPDIR_ST/state-test-12.json"
    activate_core "test-12" "/tmp" "plan" "new focus"
    local iter12 kind12
    iter12=$(jq -r '.iteration' "$TMPDIR_ST/state-test-12.json")
    kind12=$(jq -r '.kind' "$TMPDIR_ST/state-test-12.json")
    assert "re-activate preserves iteration" test "$iter12" -eq 3
    assert "re-activate switches kind" test "$kind12" = "plan"

    # --- Test: activate clears paused ---
    set_paused "test-12" true
    activate_core "test-12" "/tmp" "plan" ""
    local paused12
    paused12=$(jq -r '.paused' "$TMPDIR_ST/state-test-12.json")
    assert "activate clears paused" test "$paused12" = "false"

    # --- Test: resume when not active ---
    output=$(cmd_resume "test-none" 2>/dev/null) || true
    assert "resume when inactive → not active msg" echo "$output" | grep -q "not active"

    # --- Test: resume when paused ---
    activate_core "test-13" "/tmp" "code" "test focus"
    set_paused "test-13" true
    output=$(cmd_resume "test-13" 2>/dev/null) || true
    assert "resume prints prompt" echo "$output" | grep -q "carefully read over"
    local paused13
    paused13=$(jq -r '.paused' "$TMPDIR_ST/state-test-13.json")
    assert "resume clears paused" test "$paused13" = "false"

    # --- Test: cmd_max ---
    cmd_max "10" >/dev/null 2>&1
    local max_val
    max_val=$(jq -r '.max_iterations' "$CONFIG_FILE")
    assert "cmd_max sets value" test "$max_val" -eq 10
    cmd_max "7" >/dev/null 2>&1  # reset

    # --- Test: Stop with exit phrase at iter == max-1 → terminates via exit (step 6 before step 7) ---
    activate_core "test-14" "/tmp" "code" ""
    jq '.iteration = 6' "$TMPDIR_ST/state-test-14.json" > "$TMPDIR_ST/state-test-14.json.tmp" \
        && mv "$TMPDIR_ST/state-test-14.json.tmp" "$TMPDIR_ST/state-test-14.json"
    make_transcript "$TMPDIR_ST/transcript-14.jsonl" "All good. No issues found."
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-14","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-14.jsonl"}') 2>/dev/null) || true
    assert "Exit phrase at max-1 → allow stop (exit check before increment)" test -z "$output"
    assert_file_missing "state deleted via exit phrase" "$TMPDIR_ST/state-test-14.json"

    # --- Test: write_state failure recovery ---
    activate_core "test-15" "/tmp" "code" ""
    make_transcript "$TMPDIR_ST/transcript-15.jsonl" "Still looking..."
    chmod 0 "$TMPDIR_ST/state-test-15.json" 2>/dev/null || true
    output=$( (handle_stop '{"hook_event_name":"Stop","session_id":"test-15","cwd":"/tmp","transcript_path":"'"$TMPDIR_ST"'/transcript-15.jsonl"}') 2>/dev/null) || true
    # Restore permissions for cleanup
    chmod 644 "$TMPDIR_ST/state-test-15.json" 2>/dev/null || true
    rm -f "$TMPDIR_ST/state-test-15.json"
    assert "Write failure → no block output" test -z "$output"

    # --- Summary ---
    echo ""
    echo "Selftest: $pass/$total passed, $fail failed"
    if [ "$fail" -gt 0 ]; then
        return 1
    fi
    return 0
}

# ─── Dispatch ────────────────────────────────────────────────────────────────

if [ $# -eq 0 ]; then
    # Hook mode
    stale_sweep
    input=$(cat)
    event=$(jq -r '.hook_event_name' <<<"$input")
    case "$event" in
        Stop)              handle_stop "$input" ;;
        UserPromptSubmit)  handle_user_prompt "$input" ;;
        *)                 exit 0 ;;
    esac
else
    # Subcommand mode
    case "$1" in
        selftest)
            cmd_selftest
            ;;
        max)
            cmd_max "${2:-}"
            ;;
        auto)
            cmd_auto "${2:-toggle}"
            ;;
        interrupt)
            cmd_interrupt "${2:-}"
            ;;
        activate|deactivate|pause|resume|status)
            if ! SESSION_ID=$(resolve_session_id); then
                exit 2
            fi
            case "$1" in
                activate)    cmd_activate   "$SESSION_ID" "${2:-code}" "${REVIEW_LOOP_FOCUS:-}" ;;
                deactivate)  cmd_deactivate "$SESSION_ID" ;;
                pause)       cmd_pause      "$SESSION_ID" ;;
                resume)      cmd_resume     "$SESSION_ID" ;;
                status)      cmd_status     "$SESSION_ID" ;;
            esac
            ;;
        *)
            echo "Unknown subcommand: $1" >&2
            exit 2
            ;;
    esac
fi
