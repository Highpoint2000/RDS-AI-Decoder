# RDS AI Decoder
An intelligent RDS decoder plugin for fm-dx-webserver that reconstructs RDS data from weak or error-prone signals using weighted voting, confidence tracking and live fmdx.org reference data.
<img width="2548" height="868" alt="image" src="https://github.com/user-attachments/assets/47faa360-411f-4144-b1e2-e02ca7e0485d" />


## Version 3.2

- Sporadic-E Tracking & Clustering: A new geographic anchor system tracks strong signals (>800 km) for 10 minutes and forms a cluster within a 250 km radius. This allows for more precise identification of transmitter locations with ambiguous PI codes.
- Interactive DX Map (Leaflet): A fully integrated real-time map within the client, featuring a filter bar for signal age and a dynamic dropdown menu that automatically populates with currently received ITU country codes.
- Real-Time Station List: A new, live-sortable table view displaying stations organized chronologically or by distance, status, or PI code.
- UI State Persistence: Open windows (log, map, list)—including their positions and sizes—as well as selected options (such as "Auto TX") are restored after a page reload.
- Dynamic ERP/Distance Scoring: Hard-coded power thresholds have been replaced by a proportional scoring system that dynamically relates transmission power (ERP) to exact distance, significantly improving the accuracy of local DX matches.


### Important note: After installing this version or version 3.1 for the first time, the web server must be restarted twice!

## Installation notes:

1. [Download](https://github.com/Highpoint2000/RDS-AI-Decoder/releases) the last repository as a zip
2. Unpack all files from the plugins folder to ..fm-dx-webserver-main\plugins\ 
3. Stop or close the fm-dx-webserver
4. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations
5. Activate the RDS AI Decoder plugin  in the settings
6. Stop or close the fm-dx-webserver
7. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations 
8. Reload the browser

## How to use:     
                                         
Detailed documentation on how the plugin works can be found [here](https://highpoint.fmdx.org/manuals/RDS-AI-Decoder-Documentation.html)
Demo videos can be viewed [here](https://highpoint.fmdx.org/videos/RDS-AI-Decoder-Demo.mp4) and [here](https://highpoint.fmdx.org/videos/RDS-AI-Decoder-SpE.mp4)
A live demo with the RDS Follow function activated is available [here](http://highpoint2000.selfhost.de:8080) and [here](http://highpoint2000.selfhost.de:9080)
Recorded Raw RDS data can be analyzed and validated using this [web tool](https://highpoint.fmdx.org/webtools/rds-raw-decoder.html)

## Contact

If you have any questions, would like to report problems, or have suggestions for improvement, please feel free to contact me! You can reach me by email at highpoint2000@googlemail.com. I look forward to hearing from you!

<a href="https://www.buymeacoffee.com/Highpoint" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

<details>
<summary>History</summary>

### Version 3.1a (Hotfix Version)

- Fixed a critical race condition where changing frequencies or receiving a new PI code via Sporadic-E would temporarily inject the previous station's AI metadata into the native webserver logs
- Empty PS string is now explicitly passed to the WebSocket and Webserver as exactly 8 spaces (" ") instead of a null or empty string


### Version 3.1

- Automatic patching function for tx_search.js: After successfully detecting a transmitter, the plugin automatically determines the TX data and transfers it at high speed to the main user interface's data pipeline and the WebSocket.
- Fixed an issue with passing raw RDS data to the WebSocket when RDS Follow is active.

### Version 3.0a (Hotfix Version)

- ECC Country Flag Fix: Restored the legacy country-mapping logic. The server now explicitly sets country_iso to 'UN' (Unknown) when no Extended Country Code (ECC) is received, preventing the web server from incorrectly guessing a country flag based solely on the PI code.  
- Admin UI Restoration: Implemented the Admin Padlock (🔒/🔓) UI and logic into the client-side plugin, enabling guest users to toggle the RDS Follow feature when unlocked by an administrator.

### Version 3.0

- New Stateless Architecture: Completely removed the local database (rdsm_memory.json), which eliminates persistent "Ghost PIs" and the need for manual cleanups.
- Replaced the old point-based voting system with an instant, real-time mathematical matching engine using "Perfect Frame" and "Chimera" logic.
- Automatically fetches global transmitter data via the FMDX API for incoming signals, bypassing previous local distance (QTH) restrictions.
- Modular Realtime Log: Introduced a detached, draggable, and resizable log panel featuring granular, inclusive data filters (PS, RT, AF, ECC, TP, TA, etc.).
- MUF Auto-Record & Analytics: Added region-based MUF tracking that triggers automatic server-side CSV recording. The UI now displays rich analytics like transmitter distance, azimuth, and ERP/Polarization.
- RAW Decoder Integration: Full support for parallel live usage (via WebSocket) and post-event forensics (CSV analysis) alongside the standalone RDS RAW Decoder tool: https://highpoint.fmdx.org/webtools/rds-raw-decoder.html

### Version 2.8

- MUF detection (automatic start/stop) integrated for automatic RDS raw recording. Admins can choose between MUF EU, NA, and AU within the plugin.
- Design adjustments

### Version 2.7

- Added server-side recording function: Records incoming raw RDS data (groups, block hex codes, error levels, and AI prediction data). The raw RDS data is saved directly as a CSV file on the server (../../web/logs).
- Client-side recording control: Administrators can start and stop recording via the user interface (new record button (⏺)  in the panel header); a direct download link becomes available once recording stops.
- Raw RDS 

### Version 2.6

- Spatial Awareness (SpE Cloud Tracking): The AI now tracks the geometric center (ITU/Azimuth) of active Sporadic-E clouds over a 5-minute window, effectively eliminating false logs from incorrect directions during PI collisions.
- 5-Minute SpE Cache: DX stations (>800 km) are aggressively purged from local memory exactly 5 minutes after signal loss to prevent long-term PI blocking.
- Dummy-PI Blocker: Single FMDX database candidates are now strictly validated against live PS characters and rejected on conflict, preventing uncoordinated "Dummy PI" mismatches.
- Long-Press Toggle & Admin Padlock: RDS Follow is now toggled via a long-press (600ms) on the main navigation button. A new Admin Padlock UI (🔒/🔓) allows unlocking the feature for public guest users.
- Database Auto-Wipe Mechanism: A seamless one-time wipe routine safely handles database schema updates while perfectly preserving administrative settings.

### Version 2.5a

- AI algorithm optimized for error minimization

### Version 2.5

- Native PI and PS are now displayed in the Statistics and made available via the WebSocket for further use (logging by the scanner, starting from version 4.5)

### Version 2.4g

- Meteor Scatter & Ghost PI Suppression: Added a dynamic PI confirmation threshold based on distance (1 hit for local, 4 hits for distant/unknown signals). The threshold lowers automatically if clean PS characters are decoded.
- Anti-Hallucination (Scatter Mode): Prevents the system from guessing (hallucinating) a station name from the FMDX database if a PI code is received via a brief scatter ping with zero valid PS characters.
- Local Truth Override: Bypasses the strict database enforcement if a mathematically perfect PS string (all 8 characters at error level 0 or 1) is decoded live, allowing bespoke local test transmitters or rebranded stations to be locked

### Version 2.4f

- Algorithm hardened against duplicate PI codes on the same frequency

### Version 2.4e

- Solved problem with flickering ECC flags

### Version 2.4c

- Troubleshooting flickering ECC flags


### Version 2.4b

- ECC table completely revised

### Version 2.4a

- Faulty ECC codes fixed (e.g. Portugal)

### Version 2.4

- Added a new "LOCAL DB" section to the client panel that displays all historically saved database entries (PI, PS, seen count, and dynamic status) specifically for the currently tuned frequency
- Logged-in administrators now see a red '✕' button next to each local database entry. Clicking this prompts a confirmation dialog and allows admins to permanently delete corrupted or outdated entries from the AI's local memory.
- Switched the delete button's event listener from click to mousedown with event delegation. This fixes the issue where rapid UI updates (DOM refreshes) would cause the delete action or confirmation popup to be ignored.
- The draggable decoder panel now saves its position to the browser's localStorage. When you refresh the page, the panel will reappear exactly where you left it instead of resetting to the default position.
- Replaced basic distance sorting with an advanced calculatePropagationScore algorithm. The system now factors in ERP (transmitter power), Tropospheric/Sporadic-E distance ranges, and shared transmitter sites to find the most realistic fmdx.org reference match.


### Version 2.3

- Added robust validation to completely block hardware CRC collisions (false 100% error-free reports) from locking or displaying garbage PS names
- Lowered the minimum character requirement to allow proper database saving and locking of 2-3 letter station names 
- Implemented an active filter that strictly validates the locally voted string against FMDX variants before feeding it to the webserver UI, preventing trailing garbage
- Added a startup routine (sanitizeDatabaseWithFmdx) that scans the local memory and automatically purges historically corrupted PS entries using the latest FMDX reference data
- Forced empty slots to remain as spaces for known static stations, preventing random hardware noise from filling gaps in the UI


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
