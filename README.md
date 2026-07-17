# LCBF '26 Smart Pour Tracker 🍻

A real-time, offline-first companion app built specifically for the **London Craft Beer Festival 2026** at Southwark Park. Track your pours, sync with your friends, and calculate exactly how you are pacing the session.

---

### **THE 15-SECOND SPRINT (For when the line is moving)**

1. **Scan the QR Code** below or open the app locally on your device.
2. **Enter your name & group code** (e.g., `LCBF26`) to instantly sync leaderboards with your mates[cite: 10].
3. **Log your pours** directly from the live-parsed tap list. The app queues your logs offline and syncs to the cloud the moment you get a signal[cite: 10].

---

### **HOW TO LAUNCH**
1. Run `npm run dev` (or open your local `index.html` server).
2. Scan this QR Code to load it up on your phone:

<p align="center">
  <img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&color=f43f5e&data=http://localhost:3000" alt="LCBF26 App QR Code" width="250" />
  <br>
  <sub>Scan with your phone to open the local server (assumes port 3000)</sub>
</p>

---

### **WHAT YOU NEED TO KNOW (The Deep-Dive for the sober-ish)**

If you made it this far past the line, here is why this is much more than a basic tally-counter. Under the hood, we are doing some serious heavy lifting to make sure you have the smartest companion in the park:

#### **1. The Zero-Order Kinetics Timeline Simulation**
Most BAC trackers do a simple, flat-rate calculation based on total units consumed. Ours does not. The app tracks your exact timeline of check-ins and processes a dynamic metabolic decay simulation using Widmark's model updated sequentially[cite: 10]:

$$\text{BAC}(t) = \max \left( 0, \, \text{BAC}(t_{i-1}) - \beta \cdot \Delta t \right) + \Delta \text{BAC}_i$$

*   **Continuous Elimination:** It simulates your liver's zero-order clearance rate ($\beta = 0.015\% / \text{hour}$) dynamically across the interval between every single pour[cite: 10].
*   **Time-Weighted Scaling:** It maps the exact timestamp of your pours so that a heavy hitter logged at 12:00 PM is almost completely metabolised by 5:00 PM, giving you a continuous, realistic graph of your current physical profile[cite: 10].

#### **2. Real-Time Sync & Group Leaderboards**
Powered by Supabase Realtime Channels, your group’s stats update on the fly[cite: 10].
*   **Postgres Mutex Filtering:** The moment your mate logs a Belgian Lambic across the tent, the database triggers a broadcast, modifying your local standings table instantly[cite: 10, 11].
*   **Conflict-Free Offline Storage:** Weak signal? Logs are queued locally using `localStorage` with UUID generation[cite: 10]. The second you step out of the crowd and regain connection, background workers silently flush pending logs to the cloud[cite: 10].

#### **3. Live-Parsed Tap Lists**
Rather than hardcoding the tap list, the app dynamically loads and sanitises a localised `beers.json` payload[cite: 10, 11].
*   **Session Filtering:** It automatically filters down to only what is pouring for the active session (e.g., Friday PM)[cite: 10, 11].
*   **Text Sanitisation:** It strips HTML tags, decodes legacy entity symbols, and groups beers into distinct "Hoppy, Dark, Sour, Crisp" stylistic bins[cite: 10].

#### **4. Designed for Mobile**
*   **App-Like Feel:** The layout blocks default browser rubber-banding and text selection on mobile devices, keeping the interface snappy and preventing accidental highlights when you are tapping in a hurry[cite: 9].
*   **Trophy Room:** You can unlock dynamically calculated achievements based on style diversity (e.g., logging beers from 3 distinct style buckets) or smart pacing[cite: 10].
