#!/usr/bin/env python3
"""Notification hook: permission_prompt -> Telegram értesítés az ágens csatornáján."""
import os
import sys
import urllib.request
import json

notification_type = os.environ.get('CLAUDE_NOTIFICATION_TYPE', '')
if notification_type != 'permission_prompt':
    sys.exit(0)

message = os.environ.get('CLAUDE_NOTIFICATION_MESSAGE', 'Permission kérés')
project_dir = os.environ.get('CLAUDE_PROJECT_DIR', '')
agent_name = os.path.basename(project_dir) if project_dir else 'ismeretlen'

env_file = os.path.join(project_dir, '.claude', 'channels', 'telegram', '.env')
token = None
try:
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith('TELEGRAM_BOT_TOKEN='):
                token = line.split('=', 1)[1].strip().strip('"\'')
                break
except Exception:
    sys.exit(1)

if not token:
    sys.exit(1)

chat_id = '5757969209'
text = (
    f'Figyelem: {agent_name} jóváhagyást kér a terminálban.\n\n'
    f'{message}\n\n'
    'Nyisd meg a terminált (tmux) és nyomj 1-et a jóváhagyáshoz.'
)

data = json.dumps({'chat_id': chat_id, 'text': text}).encode('utf-8')
req = urllib.request.Request(
    f'https://api.telegram.org/bot{token}/sendMessage',
    data=data,
    headers={'Content-Type': 'application/json'}
)
try:
    urllib.request.urlopen(req, timeout=10)
except Exception:
    pass
