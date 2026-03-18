# RDS AI Decoder
An AI-powered RDS monitor for fm-dx-webserver that uses machine learning to predict and correct PS and RadioText data even under poor reception conditions.
<img width="1592" height="846" alt="Image" src="https://github.com/user-attachments/assets/3ba0548a-911b-4377-b128-2209bf131448" />

## Version 2.0

- fmdx.org Database Integration – Automatically downloads and caches the FM transmitter database from maps.fmdx.org, using transmitter coordinates, PI codes, and PS name variants for instant station identification – no learning phase needed for known stations.
- PS Lock Engine – Once a PS name is verified (via raw RDS, fmdx.org match, or DB), it is locked and displayed without flickering, even during high BER conditions. Unlocks only on frequency or PI change.
- Support for Dynamic PS – When a station broadcasts multiple PS name variants (e.g. alternating between Antenne and Antenne 1), the plugin dynamically switches the displayed name to match the currently received variant.
- RDS Expert Support – In RDS Follow mode, the native decoder is still called with the unmodified raw data stream, ensuring full compatibility with RDS Expert and other external analysis tools connected via the raw WebSocket.
- GPS-based Location Tracking – Listens to a GPS WebSocket (/data_plugins) and automatically rebuilds the fmdx.org index when the receiver location changes, always keeping the transmitter database relevant to the current position.
- AF (Alternate Frequency) Support – Decodes and caches alternative frequencies from Group 0A, feeds them to the web server UI, and displays them as a live "AF N" flag in the plugin panel.
- Hybrid PS Construction – When a fmdx.org reference exists, the plugin builds a hybrid PS string that uses the raw RDS character case where it matches the reference, and falls back to the reference where the live signal is too noisy.
- Expanded Statistics Panel – The panel now shows fmdx.org reference data (station name, distance in km, match score in %), live PS variant chips with colour-coded match highlighting, and an AF flag with tooltip listing all alternate frequencies.

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

Detailed documentation on how the plugin works can be found [here](https://highpoint.fmdx.org/manuals/RDS-AI-Decoder-Documentation-v2.0.html)
A demo video can be viewed [here](https://highpoint.fmdx.org/videos/RDS-AI-Decoder-Demo.mp4)
A live demo with the RDS Follow function activated is available [here](http://highpoint2000.selfhost.de:8080)

## Notes: 

- All data is cached in the file rdsm_memory.json in the specific plugin folder. Different retention periods apply to the data
- Once activated, Follow Mode remains active even after a restart, as long as the file rdsm_memory.json is not deleted

## Contact

If you have any questions, would like to report problems, or have suggestions for improvement, please feel free to contact me! You can reach me by email at highpoint2000@googlemail.com. I look forward to hearing from you!

<a href="https://www.buymeacoffee.com/Highpoint" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
