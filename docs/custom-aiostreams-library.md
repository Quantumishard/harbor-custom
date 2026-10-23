# Harbor AIOStreams Usenet library

This custom Harbor update adds an AIOStreams tab to Library. It uses the existing AIOStreams dashboard APIs and built-in NNTP engine. It requires no edits to your hosted instance.

## First connection

1. Fully quit Harbor, including its tray instance.
2. Extract the entire new Windows portable ZIP into a new folder and run `harbor.exe`. Keep its accompanying files together.
3. Open **Library → AIOStreams** and enter your private AIOStreams instance's base URL.
4. Select **Open sign-in window**. Complete the ElfHosted sign-in and, if prompted, the AIOStreams dashboard login. Use an account that can access **Usenet → Library**.
5. Keep **Remember sign-in on this Windows account** checked. Leave the sign-in window open. Return to Harbor and select **I’m signed in — connect library**. Harbor verifies library access and closes the sign-in window.
6. Search or filter your imported releases, open one, then select a video file to play it.

The first authenticated connection and real provider playback still need to be tested with your login. The unauthenticated checks confirmed that your instance is reachable and uses an additional ElfHosted browser sign-in.

## Included

- Browser sign-in for instances protected by a hosting login, plus direct dashboard password login for instances without that extra login.
- Server-side library search, status filters, newest/oldest date ordering and 50-release pagination.
- File selection for releases containing several videos, including archive paths and file index zero.
- Playback through Harbor's native player, with a loopback relay that supplies hosting cookies and forwards HTTP range requests for seeking.
- Remembered sign-in on Windows: session cookies are encrypted using Windows user protection and restored when you return to the library after restarting Harbor. Passwords are not saved. Disconnect removes the saved session. Hosting cookies are not passed to the player or saved in Harbor settings.
- Sign-in windows use a private browser session. Uncheck the remember option to use only a temporary session.

## Session and playback notes

You do not need to sign in after every restart when the remember option is enabled. Harbor checks the saved session when you open **Library → AIOStreams**. Sign in again if the hosted session expires or is revoked; network failures leave the saved session intact so you can retry. Windows protection ties the saved session to your Windows account on this computer.

To resume after restarting, open the same file from **Library → AIOStreams** after Harbor reconnects. Saved Continue Watching playback links for this source are temporary and are not a persistent shortcut across restarts.

Degraded releases can contain missing segments and may have playback gaps or fail. Queued, inspecting and failed releases can be browsed but their files cannot be started from this tab until available. Refresh to retrieve updated status.

If sign-in fails, confirm that the sign-in window can reach the actual AIOStreams dashboard. A hosting login alone may not grant AIOStreams administrator access. An unsupported API response can also mean the hosted instance runs a different API version.

This update browses and plays existing imported NZBs. It does not add, delete, repair or change releases or providers. Its playback relay runs on this computer; casting this source to another device is not included.

Your existing Harbor settings remain in AppData. The portable archive contains application files, not a personal-data backup. Avoid running old and new Harbor versions simultaneously.
