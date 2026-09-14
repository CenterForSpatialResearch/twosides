twosides — Two Sides of the Same Coin
Interactive for "Full Disclosure: The Edge of Information Design", at
the Museum of Modern Art

HOW TO RUN
----------
This folder is a static web app. It needs a local web server. It will NOT
work by opening index.html directly.

Easiest:
  macOS:    double-click  start-macos.command
  Windows:  double-click  start-windows.bat

A browser opens at http://localhost:8000 (or 8001, 8002, ... if 8000 is
already taken). If the page is blank, wait a second and refresh. Leave the
terminal window open while the piece is running; closing it stops the server.

The launchers need Python 3 on both macOS and Windows.
You can download an installer here: https://www.python.org/downloads/

macOS, first run only: if you see "cannot open start-macos.command", go to
System Settings -> Privacy & Security and scroll down to the "Allow
applications from" section under "Security". There should be a message that
says "start-macos.command" was blocked to protect your Mac. Select "Open Anyway."
If macOS offers to install "command line developer tools", accept — that
installs Python, which the launcher uses.

Windows, first run only: if you see a "this publisher cannot be verified"
pop-up window, uncheck "Ask this every time" and click "Run Anyway."

Manual (if the launchers don't work):
  macOS / Linux:  open Terminal in this folder, then
                    python3 -m http.server 8000
  Windows:        open PowerShell in this folder, then
                    py -3 -m http.server 8000
  Either, with Node.js installed:
                    npx serve -l 8000
  Then open http://localhost:8000 in a browser.

PERFORMANCE
-----------
The piece runs best in Chrome or Safari.

On Windows, for the smoothest performance, set the machine to its fastest power
mode: Settings -> System -> Power & battery -> Power mode -> Best performance.

Windows may throttle the browser in "Efficiency mode" (a green leaf next to it
in Task Manager), which may affect performance. To turn this off for Chrome:
  1. Right-click the Chrome desktop shortcut and choose Properties.
  2. At the end of the Target field, after the closing quote, type a space
     and then:  --disable-features=UseEcoQoSForBackgroundProcess
  3. Click OK. Quit Chrome fully, open it from that shortcut, then run
     start-windows.bat.

NOTES
-----
- Do not open index.html as a file. The app uses ES modules and fetch(),
  which browsers block without a server. You will get a blank page.
- The piece returns to the splash screen after 30 seconds without input.
  To turn that off, add ?idle=0 to the page URL, e.g. http://localhost:8000/?idle=0
- Once served, the app runs fully offline. No network is needed.

Source and releases:
  https://github.com/CenterForSpatialResearch/twosides
