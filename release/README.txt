twosides — Two Sides of the Same Coin
Interactive for "Full Disclosure: The Edge of Information Design", MoMA


HOW TO RUN
----------
This folder is a static web app. It needs a local web server. It will NOT
work by opening index.html directly.

Easiest:
  macOS:    double-click  start-macos.command
  Windows:  double-click  start-windows.bat

A browser opens at http://localhost:8000 . If the page is blank, wait a
second and refresh. Leave the terminal window open while the piece is
running; closing it stops the server.

macOS, first run only: if you see "cannot be opened because it is from an
unidentified developer", right-click start-macos.command and choose Open.
If macOS offers to install "command line developer tools", accept — that
installs Python, which the launcher uses.

Manual (if the launchers don't work):
  macOS / Linux:  open Terminal in this folder, then
                    python3 -m http.server 8000
  Windows:        open PowerShell in this folder, then
                    py -3 -m http.server 8000
  Either, with Node.js installed:
                    npx serve -l 8000
  Then open http://localhost:8000 in a browser.


NOTES
-----
- Do not open index.html as a file. The app uses ES modules and fetch(),
  which browsers block without a server. You will get a blank page.
- The piece returns to the splash screen after 30 seconds without input.
  To turn that off while troubleshooting, add ?idle=0 to the page URL,
  e.g. http://localhost:8000/?idle=0
- Once served, the app runs fully offline. No network is needed.


Source and releases:
  https://github.com/CenterForSpatialResearch/twosides
