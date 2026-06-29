#!/usr/bin/env bash
# fleet.sh -- 6-pane tmux fleet monitor
# Usage: bash ~/marveen/scripts/fleet.sh
#
# Layout (3x2):
#   [ dex        ] [ atlas      ] [ iris       ]
#   [ nova       ] [ orin-chan  ] [ FLEET HEALTH]
#
# Readonly watch view. Az ágensekbe lépéshez: tmux switch-client -t agent-dex

set -euo pipefail

FLEET="fleet"
MARVEEN_DIR="$HOME/marveen"
HEALTH_SCRIPT="$MARVEEN_DIR/scripts/fleet-health.sh"

SESSIONS=(agent-dex agent-atlas agent-iris agent-nova orin-channels)
LABELS=(DEX ATLAS IRIS NOVA ORIN-CH)

# Kill existing fleet session
tmux kill-session -t "$FLEET" 2>/dev/null || true

# New session (detached) -- 200 sor kell: a lánc-splits felezik az előző pane-t,
# 5 split -> 100->50->25->12->6 sor, ez még épp elfér. 50 sornál "no space" hiba.
tmux new-session -d -s "$FLEET" -x 220 -y 200

# 3x2 grid: először 3 oszlop (vízszintes splitek), majd minden oszlopot felezünk
# -- ez garantáltan elfér, mert sosem megy 25 sor alá egy pane sem.
tmux split-window -t "$FLEET:0.0" -h         # 2 oszlop
tmux split-window -t "$FLEET:0.1" -h         # 3 oszlop
tmux split-window -t "$FLEET:0.0" -v         # bal oszlop: felső/alsó
tmux split-window -t "$FLEET:0.2" -v         # középső oszlop: felső/alsó
tmux split-window -t "$FLEET:0.4" -v         # jobb oszlop: felső/alsó

# Egyenletes elosztás
tmux select-layout -t "$FLEET" tiled

# Pane sorrend tiled után: bal-felső=0, közép-felső=1, jobb-felső=2,
#                          bal-alsó=3,  közép-alsó=4,  jobb-alsó=5
# Ágensek: DEX(0) ATLAS(1) IRIS(2) NOVA(3) ORIN-CH(4) HEALTH(5)
# watch -n5 -ct: villogásmentes frissítés (csak a változott sorokat írja felül)
for i in "${!SESSIONS[@]}"; do
  SESSION="${SESSIONS[$i]}"
  LABEL="${LABELS[$i]}"
  tmux send-keys -t "$FLEET:0.$i" \
    "watch -n5 -ct -- 'printf \"\\033[1m=== ${LABEL} ===\\033[0m\n\"; tmux capture-pane -p -t ${SESSION}:0.0 2>/dev/null || printf \"[nem fut]\n\"'" \
    Enter
done

# Pane 5: fleet health panel (10s frissítés elég)
tmux send-keys -t "$FLEET:0.5" \
  "watch -n10 -ct -- 'bash ${HEALTH_SCRIPT}'" \
  Enter

# Focus top-left (dex)
tmux select-pane -t "$FLEET:0.0"

# Attach
exec tmux attach-session -t "$FLEET"
