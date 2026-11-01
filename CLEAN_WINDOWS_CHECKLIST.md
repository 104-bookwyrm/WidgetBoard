# Clean Windows installation checklist

Run on clean Windows 10 and Windows 11 x64 machines with a standard user account. Record OS version, result, and any prompt shown. Use a signed release installer for trust checks.

## Install and migrate

- [ ] Run `WidgetBoard-<version>-setup-x86_64.exe` without administrator elevation. Record the publisher shown by Windows and any SmartScreen observation. Do not treat SmartScreen reputation as an automated pass condition.
- [ ] Confirm installation under `%LOCALAPPDATA%\WidgetBoard` and launch from the Start menu.
- [ ] Confirm the Start menu shortcut and the WidgetBoard uninstall entry in Windows Installed Apps / Apps & features.
- [ ] Confirm existing user data is reused from `%APPDATA%\app.widgetboard.desktop`. Existing widgets and settings should appear without copying or moving that directory.
- [ ] For each of the three portable users, close the portable app, install the signed installer, launch it, and confirm the existing widgets and settings. Check that an existing `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WidgetBoard` entry now points to the installed executable. The app repairs an existing stale path at startup.
- [ ] If Task Manager had disabled WidgetBoard at startup, confirm it remains disabled after migration. Do not re-enable it as part of the check.
- [ ] If no Run entry existed, confirm installation does not create one. Check that an unrelated Run entry remains unchanged.
- [ ] If the Run entry belongs to another executable, confirm the app does not claim it. During uninstall, confirm the foreign value is restored.
- [ ] At the installer prompt for a running application, choose **Cancel**. Confirm the installed app and user data remain available.

## Update and uninstall

- [ ] Offer an update and approve it. Confirm the passive NSIS update completes and WidgetBoard relaunches with the same boards and settings.
- [ ] Uninstall from Windows Installed Apps. Confirm application files and shortcuts are removed.
- [ ] Confirm `%APPDATA%\app.widgetboard.desktop` remains. User data is retained by uninstall.

## Record

- [ ] Record Windows version, installer version, standard-user status, publisher subject, SmartScreen observation, update and relaunch result, uninstall result, and any deviations.

The three existing portable users migrate once by installing the signed installer over their existing per-user data. Keep the old executable until the installed copy has been checked. Delete it afterward if desired.
