# younow-tempermonkey-scripts

# YouNow Treasure Chest Auto Opener

A Tampermonkey userscript that automates the Treasure Chest opening workflow on YouNow, with configurable like thresholds, live chest-like verification, timers, and a persistent opening history.

## Script

**Current repository file:** [YouNow_Chest_Auto_Opener_v9.61.txt](https://github.com/Cenastor/younow-tempermonkey-scripts/blob/main/YouNow_Chest_Auto_Opener_v9.61.txt)

[View the raw userscript](https://raw.githubusercontent.com/Cenastor/younow-tempermonkey-scripts/main/YouNow_Chest_Auto_Opener_v9.61.txt)

## Features

- **Automatic chest opening** — runs the chest-opening workflow when the configured like threshold is reached.
- **Configurable like threshold** — set the target number of likes; the script enforces a minimum threshold of 500.
- **Live chest likes detection** — opens the actual Treasure Chest panel to read its likes rather than relying only on broadcast likes.
- **Timed rechecks** — configure how often the script checks the chest while waiting for the target.
- **Live verification window** — keeps the chest panel open briefly during a check so likes arriving during the check can be detected.
- **Optional opening delay** — configure a delay between reaching the target and opening the chest.
- **Optional chat messages** — send a configurable message when the chest reaches its target and is about to open.
- **Periodic information messages** — optionally post a reminder explaining the automatic chest target.
- **Custom chest-open sound** — choose an audio file, test it, enable or disable playback, and adjust volume. The selected sound is stored locally in the browser.
- **Movable helper panel** — drag the on-page control panel to a convenient position.
- **Minimize and maximize controls** — adjust the panel display without removing the helper.
- **Persistent settings** — retain configuration between page reloads using Tampermonkey storage.
- **Broadcast safety check** — checks whether your own YouNow broadcast is active before performing broadcast-dependent actions.
- **Winners-panel cleanup** — attempts to close the Winners panel as part of the completed opening workflow.
- **Persistent chest history** — records successfully completed openings with the time, cycle number, likes, target, and opening delay.
- **Completed-cycle counter** — increments after the full opening and cleanup sequence completes, rather than for every likes check.
- **History reset** — clear the chest history without resetting the automation settings.
- **Status and action feedback** — displays the current workflow status and recent action information.

## Installation

1. Install the [Tampermonkey browser extension](https://www.tampermonkey.net/).
2. Open the [userscript file on GitHub](https://github.com/Cenastor/younow-tempermonkey-scripts/blob/main/YouNow_Chest_Auto_Opener_v9.61.txt).
3. Copy the script into a new Tampermonkey userscript, or download the file and import/open it using a supported browser workflow.
4. Save the userscript and visit [YouNow](https://www.younow.com/).
5. Review the helper panel and configure the threshold, timers, chat messages, and sound options to suit your preferences.

## Notes

- This script is intended for use on YouNow in a browser with Tampermonkey support.
- Browser permissions, autoplay restrictions, or changes to YouNow's page structure may affect some features.
- Keep the script updated if YouNow changes the Treasure Chest or Winners interfaces.
- Use automation responsibly and ensure your use complies with YouNow's current rules and terms.

## Version

The linked repository filename is **v9.61**. Check the source file for the implementation and latest changes.
