# RDS AI Decoder
An intelligent RDS decoder plugin for fm-dx-webserver that reconstructs RDS data from weak or error-prone signals using weighted voting, confidence tracking and live fmdx.org reference data.
<img width="1650" height="852" alt="grafik" src="https://github.com/user-attachments/assets/0358e789-5dbb-4113-a694-f1ea33adfd56" />

## Version 2.3

- Added robust validation to completely block hardware CRC collisions (false 100% error-free reports) from locking or displaying garbage PS names
- Lowered the minimum character requirement to allow proper database saving and locking of 2-3 letter station names 
- Implemented an active filter that strictly validates the locally voted string against FMDX variants before feeding it to the webserver UI, preventing trailing garbage
- Added a startup routine (sanitizeDatabaseWithFmdx) that scans the local memory and automatically purges historically corrupted PS entries using the latest FMDX reference data
- Forced empty slots to remain as spaces for known static stations, preventing random hardware noise from filling gaps in the UI

## Installation notes:

1. [Download](https://github.com/Highpoint2000/RDS-AI-Decoder/releases) the last repository as a zip
2. Unpack all files from the plugins folder to ..fm-dx-webserver-main\plugins\ 
3. Stop or close the fm-dx-webserver
4. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations
5. Activate the sysinfo plugin in the settings
6. Stop or close the fm-dx-webserver
7. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations 
8. Reload the browser

## How to use:     
                                         
- Click the RDS Decoder button to open the RDS monitor panel 
- As an administrator, you can activate RDS Follow Mode. This will feed the plugin's RDS data directly into the web server

Detailed documentation on how the plugin works can be found [here](https://highpoint.fmdx.org/manuals/RDS-AI-Decoder-Documentation-v2.3.html)
A demo video can be viewed [here](https://highpoint.fmdx.org/videos/RDS-AI-Decoder-Demo.mp4)
A live demo with the RDS Follow function activated is available [here](http://highpoint2000.selfhost.de:8080)

## Notes: 

- All data is cached in the file rdsm_memory.json in the specific plugin folder. Different retention periods apply to the data
- Once activated, Follow Mode remains active even after a restart, as long as the file rdsm_memory.json is not deleted

## Contact

If you have any questions, would like to report problems, or have suggestions for improvement, please feel free to contact me! You can reach me by email at highpoint2000@googlemail.com. I look forward to hearing from you!

<a href="https://www.buymeacoffee.com/Highpoint" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

<details>
<summary>History</summary>

### Version 2.2a

- Statistics are now displayed on the right side
- Unnecessary reloading of the TX database during GPS use is prevented
- Code optimizations to reduce CPU load
- Fixed error with the third decimal place in the FM DX web server frequency display

### Version 2.2

- New status field in the panel: displays decoding progress as WAIT → PROVISIONAL (with confidence % and stability in seconds) → LOCKED (with locking reason)
- Five new WebSocket fields in the rdsm_ai protocol for transmitting the Provisional/Locked state from the server to the browser
- renderStatus() – new client function that renders the status field and is automatically updated with every update and frequency change
- _aiTimer raised to the module level to prevent duplicate or outdated broadcasts on parallel code paths

### Version 2.1

- AF frequency visual validation — Received alternate frequencies (AF) are now visually highlighted in the FMDX.ORG panel. Frequencies already confirmed from the live signal are shown with a coloured chip, clearly distinguishing received AFs from database-only entries.
- Regional

### Version 2.0

- fmdx.org Database Integration – Automatically downloads and caches the FM transmitter database from maps.fmdx.org, using transmitter coordinates, PI codes, and PS name variants for instant station identification – no learning phase needed for known stations.
- PS Lock Engine – Once a PS name is verified (via raw RDS, fmdx.org match, or DB), it is locked and displayed without flickering, even during high BER conditions. Unlocks only on frequency or PI change.
- Support for Dynamic PS – When a station broadcasts multiple PS name variants (e.g. alternating between Antenne and Antenne 1), the plugin dynamically switches the displayed name to match the currently received variant.
- RDS Expert Support – In RDS Follow mode, the native decoder is still called with the unmodified raw data stream, ensuring full compatibility with RDS Expert and other external analysis tools connected via the raw WebSocket.
- GPS-based Location Tracking – Listens to a GPS WebSocket (/data_plugins) and automatically rebuilds the fmdx.org index when the receiver location changes, always keeping the transmitter database relevant to the current position.
- AF (Alternate Frequency) Support – Decodes and caches alternative frequencies from Group 0A, feeds them to the web server UI, and displays them as a live "AF N" flag in the plugin panel.
- Hybrid PS Construction – When a fmdx.org reference exists, the plugin builds a hybrid PS string that uses the raw RDS character case where it matches the reference, and falls back to the reference where the live signal is too noisy.
- Expanded Statistics Panel – The panel now shows fmdx.org reference data (station name, distance in km, match score in %), live PS variant chips with colour-coded match highlighting, and an AF flag with tooltip listing all alternate frequencies.
