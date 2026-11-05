# FridgeLink

A web simulation of **Remote Monitoring and Control of a Refrigerator Using GSM Interface**
(Arduino Uno, LM35, LDR, relay, SIM800L). Two pages: the **fridge** and the owner's **phone**.

Live demo: https://fridge-zze8.onrender.com

## How to use

1. Open the fridge page on a laptop.
2. Scan the QR code on it with your phone (or open the link).
3. Enter the access code: **209173**.
4. Text the fridge and watch it react.

| SMS command | What it does |
|---|---|
| `STATUS` | Replies with temperature, power, compressor and door state |
| `ON` / `OFF` | Switches the fridge on or off through the relay |
| `LIMIT 8` | Sets the alert temperature (2 to 15 °C) |
| `HELP` | Lists the commands |

You get an SMS alert when the temperature stays above the limit, when mains power fails or returns,
and when the door is left open.

## Controls on the fridge page

- **Fridge door**: open or close it.
- **Mains power**: cut or restore it.
- **GSM network**: take the network down or bring it back. Messages wait until it returns.
- **See inside**: make the door transparent.
- **Speed (1× to 300×)**: a power cut takes about 30 minutes of fridge time, so speed it up.
- **Lab section**: temperature chart, hardware diagram with the LCD, serial monitor (AT commands),
  and a **Test results** table that times every SMS. You can export it as CSV.

## Run it yourself

Needs [Node.js](https://nodejs.org) 18 or newer. No install step.

```
node server.js
```

(or double-click `start.bat` on Windows). Open http://localhost:8080. For a phone on the same
Wi-Fi, use the address the page shows in the QR code.

Opening `index.html` directly also works, but the phone page then only works in a tab of the same browser.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `ui.js` | Fridge page |
| `sim.js` | Simulation: fridge physics, Arduino logic, SIM800L and SMS |
| `phone.html`, `phone.css`, `phone.js` | Phone page |
| `link.js` | Connects the two pages |
| `server.js` | Serves the pages and relays messages between them |

## Hosting on Render

New Web Service from the GitHub repo, build command `npm install`, start command `npm start`.
The free plan sleeps after about 15 minutes idle and takes under a minute to wake, so open it a
few minutes before a demo.

## Notes

- This is a simulation. Temperature, delays and signal strength are modelled, not measured.
- The access code is a demo gate and is not secure. Change `ACCESS_CODE` in `ui.js` to use another.
