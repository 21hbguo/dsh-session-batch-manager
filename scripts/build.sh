#!/bin/bash
# Build @dsh-external/dsh-session-batch-manager: compile src/ → lib/ with the
# dsh checkout's tsc, then bundle the browser half with tsdown (lib/client.js).
# Requires DSH_CHECKOUT pointing at a dsh source checkout (auto-probe below).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# DSH_CHECKOUT 探测：环境变量 → 常见路径
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
link_pkg cordis vendor/cordis
# dsh 各包的 d.ts 用带 scope 的模块名（@deepseek-ai/cordis），一并链接避免类型退化
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg schemastery vendor/schemastery
# @types/node（编译类型；checkout 自带）
link_pkg @types/node node_modules/@types/node

# --- Client 侧类型依赖（仅编译期；运行时全部 external） ---
link_pkg @deepseek-ai/dsh-client-ui-slots packages/client/ui-slots
link_pkg @deepseek-ai/dsh-client-runtime packages/client/runtime
link_pkg @deepseek-ai/dsh-client-ui-settings packages/client/ui-settings
link_pkg @deepseek-ai/dsh-client-connection packages/client/connection
link_pkg @deepseek-ai/dsh-api-remotes packages/api/remotes
link_pkg @deepseek-ai/dsh-host-apiproxy packages/host/apiproxy
link_pkg @deepseek-ai/dsh-api-gateway packages/api/gateway
link_pkg @deepseek-ai/dsh-typert-protocol packages/typert/protocol
link_pkg @deepseek-ai/dsh-cordis-host-runner packages/extensions/cordis-host-runner
link_pkg @deepseek-ai/dsh-host-plugin-inventory packages/host/plugin-inventory
link_pkg @deepseek-ai/dsh-commands packages/interaction/commands
link_pkg @deepseek-ai/dsh-goal packages/goal/goal
link_pkg @deepseek-ai/dsh-message-feedback packages/feedback/message-feedback
link_pkg @deepseek-ai/dsh-credentials packages/credentials/credentials
link_pkg @deepseek-ai/dsh-agent-presets packages/preset/agent-presets
link_pkg @deepseek-ai/dsh-settings packages/settings/settings
link_pkg @deepseek-ai/dsh-session-projection packages/session/session-projection
link_pkg @deepseek-ai/dsh-session packages/core/session
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-session-persistence packages/session/session-persistence
link_pkg @deepseek-ai/dsh-brand packages/util/brand
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt

# --- react + @types/react（client bundle 的 external 依赖，仅类型需要） ---
REACT_TYPES=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@types+react@*' 2>/dev/null | head -1)
if [ -n "$REACT_TYPES" ]; then
  link_pkg @types/react "${REACT_TYPES#"$CHECKOUT/"}/node_modules/@types/react"
fi
REACT_PKG=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname 'react@*' 2>/dev/null | head -1)
if [ -n "$REACT_PKG" ]; then
  link_pkg react "${REACT_PKG#"$CHECKOUT/"}/node_modules/react"
fi

STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
    fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
  " "$STD_SCHEMA/node_modules/@standard-schema/spec"
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json

echo "=== Bundling client (tsdown) ==="
if [ -x "$CHECKOUT/node_modules/.bin/tsdown" ] || [ -f "$CHECKOUT/node_modules/.bin/tsdown.cmd" ]; then
  "$CHECKOUT/node_modules/.bin/tsdown"
elif [ -x node_modules/.bin/tsdown ]; then
  node_modules/.bin/tsdown
else
  echo "build: tsdown not found (skip client bundle)" >&2
fi

echo "=== Build complete ==="
