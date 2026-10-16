# Collecting the Dutch data on a Raspberry Pi

NDW only publishes the latest minute, so something has to fetch it every minute, around the clock. This sets up `scripts/collect-nl.mjs` as a service on a Raspberry Pi. It collects all national roads: about 2,600 locations with detectors on both carriageways, 14,500 lanes. A Zero 2 W is enough: the collector uses about 250 MB of memory and a few seconds of CPU per minute. It downloads about 1 MB a minute from NDW, writes the day files to the SD card every hour (about 20 MB at the end of the day) and uploads them to the R2 bucket the page reads every 2 hours. The live dots are uploaded every 5 minutes.

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

The first run downloads NDW's site table and pairs up the detectors into stations, which takes a minute or so on a Zero. After three minutes it writes the files and stops. To test the upload too:

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
journalctl -u lammap-nl -f   # the log: a line every 30 polls and one each time the day files are written
```

It starts again after a reboot or a crash. When stopped (`sudo systemctl stop lammap-nl`) it writes and uploads what it has first. Collected data stays in `~/lammap-data/nl`, so a restart continues where it left off; only the minutes while it was down are missing, and the page scales those hours up or leaves them out.

To update after changes in the repository:

```sh
cd ~/lammap && git pull && sudo systemctl restart lammap-nl
```

## Uploads and costs

Every station's file changes all day, so each upload of the day files is about 2,600 uploads to R2. Every 2 hours that is about 31,000 a day, 0.95 million a month, just within R2's free tier of 1 million writes a month (the Finnish data adds about 30,000). More often costs a little: `--upload-every 60` in the service file doubles it, to about €4 a month above the free tier.

## Fewer stations

To collect only part of them, stop the service and run `node scripts/collect-nl.mjs --select --stations 500 --minutes 1 --out ~/lammap-data/nl`, then start it again. That picks 500 stations spread over the country; stations that are not picked lose their history on the page. Without `--stations` (or `--stations 0`) `--select` takes all of them again, for example when Rijkswaterstaat adds detectors.
