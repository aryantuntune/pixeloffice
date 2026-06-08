#!/usr/bin/env sh
# Convenience wrapper for the PixelOffice floor-sync companion (Linux/macOS).
# Honors all FLOOR_SYNC_* env vars (they are inherited by the exec'd node
# process); just runs the Node script next to it.
#
#   FLOOR_SYNC_SERVER=http://<office-server>:2567 ./floor-sync.sh
#
# To pair regardless of IP (NAT / VPN / Docker / multiple tabs), pass the code
# shown in PixelOffice Settings after you enable "Sync my floor":
#
#   FLOOR_SYNC_SERVER=http://<office-server>:2567 \
#   FLOOR_SYNC_PAIR_CODE=ABC234 ./floor-sync.sh
#
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/floor-sync.mjs" "$@"
