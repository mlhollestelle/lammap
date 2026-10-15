# Collecting the Dutch data on a Raspberry Pi

NDW only publishes the latest minute, so something has to fetch it every minute, around the clock. This sets up `scripts/collect-nl.mjs` as a service on a Raspberry Pi (a Zero 2 W is enough: the collector uses about 150 MB of memory and a second or two of CPU per minute). It downloads about 1 MB a minute from NDW and uploads the results to the R2 bucket the page reads.

## 1. The Pi

Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In the Imager settings, set a user name and password, Wi-Fi, and enable SSH. Boot it and log in with `ssh <user>@<hostname>.local`.

Then install Node.js, rclone and git:

```sh
sudo apt update && sudo apt install -y nodejs rclone git
node --version   # 18 or newer
```

If the rclone from apt is older than 1.60, install the current one with `sudo -v; curl https://rclone.org/install.sh | sudo bash`.

## 2. Access to R2

In the Cloudflare dashboard: **R2 → Manage API tokens → Create API token**, with **Object Read & Write** permission for the lammap bucket only. Note the access key ID and secret access key, and your account ID (in the R2 overview).

Tell rclone about it (replace the three values):

```sh
rclone config create r2 s3 provider=Cloudflare region=auto acl=private no_check_bucket=true \
  access_key_id=ACCESS_KEY_ID secret_access_key=SECRET_ACCESS_KEY \
  endpoint=https://ACCOUNT_ID.r2.cloudflarestorage.com
rclone lsd r2:BUCKET   # should list stations and fd without errors
```

## 3. Try it

```sh
git clone https://github.com/mlhollestelle/lammap.git ~/lammap
cd ~/lammap
node scripts/collect-nl.mjs --minutes 3 --out ~/lammap-data/nl
```

The first run downloads NDW's site table and picks 250 stations, which takes a minute or so on a Zero. After three minutes it writes the files and stops. To test the upload too:

```sh
OUT=~/lammap-data/nl R2_DEST=r2:BUCKET scripts/upload-nl.sh fd
OUT=~/lammap-data/nl R2_DEST=r2:BUCKET scripts/upload-nl.sh live
```

The Netherlands should now show up at <https://mlhollestelle.github.io/lammap/?country=nl>.

## 4. Run it as a service

```sh
sed "s/__USER__/$USER/g; s/__BUCKET__/BUCKET/g" pi/lammap-nl.service | sudo tee /etc/systemd/system/lammap-nl.service
sudo systemctl daemon-reload
sudo systemctl enable --now lammap-nl
journalctl -u lammap-nl -f   # the log: a line every 30 minutes, plus each upload of the day files
```

It starts again after a reboot or a crash. When stopped (`sudo systemctl stop lammap-nl`) it writes and uploads what it has first. Collected data stays in `~/lammap-data/nl`, so a restart continues where it left off; only the minutes while it was down are missing, and the page scales those hours up or leaves them out.

To update after changes in the repository:

```sh
cd ~/lammap && git pull && sudo systemctl restart lammap-nl
```

## Choosing other stations

Stop the service and run `node scripts/collect-nl.mjs --select --stations 400 --minutes 1 --out ~/lammap-data/nl`, then start it again. Stations that are not picked again lose their history on the page. More stations means more memory, CPU and uploads; 250 keeps the uploads to about 12,000 a day, within R2's free tier.
