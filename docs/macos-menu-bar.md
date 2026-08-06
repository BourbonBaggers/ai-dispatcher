# macOS menu bar dispatcher status app

The menu bar app is a small native macOS status item for the Mac mini. It opens the
compact dispatcher dashboard at:

```text
http://<dispatcher-host>:8787/compact
```

The dashboard has no authentication, so reaching it at a LAN address requires explicitly
opting in to a non-loopback bind (see [README: Web dashboard](../README.md#web-dashboard))
— that opt-in also prints a warning that the dashboard exposes issue metadata, live
agent output, and repository state to anyone who can reach that address. Prefer an SSH
tunnel or authenticated reverse proxy onto the loopback default if the dispatcher host is
reachable by anyone other than its operator.

The dashboard service must already be running on the dispatcher host:

```bash
ai-dispatcher dashboard --host <dispatcher-host> --port 8787 --allow-remote
```

or installed as the user service described in the README, with
`DASHBOARD_HOST=<dispatcher-host>` (or the dispatcher host's LAN address) set
explicitly:

```bash
DASHBOARD_HOST=<dispatcher-host> scripts/install-dashboard-service.sh
```

## Build and install

Build on macOS with Xcode command line tools installed:

```bash
macos/DispatcherStatusBar/build.sh
```

Move the generated app into `/Applications`:

```bash
cp -R "macos/DispatcherStatusBar/build/Dispatcher Status Bar.app" /Applications/
```

Launch it once:

```bash
open "/Applications/Dispatcher Status Bar.app"
```

The app creates an `AD` item in the macOS menu bar. Click it to open the compact
dispatcher status view. If the dashboard is unavailable, the popover shows an offline
state with the URL it tried to load.

## Launch at login

Use macOS System Settings:

1. Open **System Settings**.
2. Open **General**.
3. Open **Login Items & Extensions**.
4. Add `/Applications/Dispatcher Status Bar.app` to **Open at Login**.

For a scripted setup, create `~/Library/LaunchAgents/com.bourbonbaggers.DispatcherStatusBar.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.bourbonbaggers.DispatcherStatusBar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Dispatcher Status Bar.app/Contents/MacOS/DispatcherStatusBar</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Then load it:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.bourbonbaggers.DispatcherStatusBar.plist"
```

## Optional URL override

The default URL is fixed for the Mac mini. To point the app at another dispatcher
dashboard, write a macOS defaults value before launching the app:

```bash
defaults write com.bourbonbaggers.DispatcherStatusBar DashboardURL "http://<dispatcher-host>:8787/compact"
```
