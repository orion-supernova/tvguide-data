#!/bin/bash
# One-time setup of the Digiturk relay on an always-on home machine (Linux, Node 22, git).
#   1) on the home machine:   bash setup-relay-host.sh key      → prints a public key
#   2) on a machine with gh:  gh repo deploy-key add <keyfile> --allow-write -R orion-supernova/tvguide-data -t home-relay
#   3) on the home machine:   bash setup-relay-host.sh install  → clones the repo, runs the relay once, adds a cron job (every 6 h)
# The deploy key can push to tvguide-data only.
set -euo pipefail
KEY=~/.ssh/tvguide_deploy
DIR=~/tvguide-data
case "${1:-}" in
  key)
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "tvguide-relay@$(hostname)" -f "$KEY"
    grep -q "Host github-tvguide" ~/.ssh/config 2>/dev/null || printf '\nHost github-tvguide\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$KEY" >> ~/.ssh/config
    chmod 600 ~/.ssh/config
    echo "Add this as a deploy key WITH write access on orion-supernova/tvguide-data:"
    cat "$KEY.pub"
    ;;
  install)
    [ -d "$DIR" ] || git clone -q github-tvguide:orion-supernova/tvguide-data.git "$DIR"
    git -C "$DIR" pull -q
    "$DIR/tools/relay.sh"
    ( crontab -l 2>/dev/null | grep -v "tvguide-data/tools/relay.sh"; echo "23 */6 * * * $DIR/tools/relay.sh >> $HOME/tvguide-relay.log 2>&1" ) | crontab -
    echo "Relay installed. Cron:"; crontab -l | grep relay.sh
    ;;
  *) echo "usage: $0 key|install"; exit 1 ;;
esac
