//% color="#006400" weight=85 icon="\uf124"
//% groups='["GNSS", "Output", "Satellites", "Raw NMEA"]'
namespace bqd357 {

    let isGnssSerial = false;
    let lastGGA: string = "";
    let lastRMC: string = "";
    let lastVTG: string = "";
    let lastGSA: string = "";
    let lastGSV: string = "";
    let gpsSatellites: Satellite[] = [];
    let bdsSatellites: Satellite[] = [];

    interface Satellite {
        id: number;
        elevation: number;
        azimuth: number;
        snr: number;
    }

    let lastValidFixMs = 0;

    // -------------------------------------------------------------------------
    // Serial port switching
    // -------------------------------------------------------------------------

    /**
     * Switch serial to GNSS module pins (P1 = RX ← module TX, P2 = TX → module RX)
     */
    //% block="use GNSS serial P1 as RX & P2 as TX baud $baud"
    //% group="GNSS" weight=100
    export function useGnssSerial(baud: number = 115200): void {
        serial.redirect(SerialPin.P1, SerialPin.P2, baud);
        isGnssSerial = true;
        basic.pause(50);
    }

    /**
     * Switch serial back to USB console
     */
    //% block="use USB serial console"
    //% group="Output" weight=90
    export function useUsbSerial(): void {
        serial.redirectToUSB();
        isGnssSerial = false;
        basic.pause(50);
    }

    /**
     * Read and parse one line from GNSS module
     */
    //% block="read & parse one NMEA line"
    //% group="GNSS" weight=80
    export function readAndParseLine(): void {
        if (!isGnssSerial) return;

        let line = serial.readLine();

        if (!line || line.length < 8 || line.charAt(0) !== "$") return;

        let parts = line.split(",");
        if (parts.length < 3) return;

        let talker = parts[0].substr(1, 2);
        let sentence = parts[0].substr(3, 3);

        // Store last sentences
        if (sentence === "GGA") lastGGA = line;
        else if (sentence === "RMC") lastRMC = line;
        else if (sentence === "VTG") lastVTG = line;
        else if (sentence === "GSA") lastGSA = line;
        else if (sentence === "GSV") {
            lastGSV = line;
            parseGSV(line);
        }

        // Update fix status timestamp
        if (sentence === "GGA" || sentence === "RMC") {
            if ((parts.length > 6 && (parts[6] === "1" || parts[6] === "2")) ||
                (parts.length > 2 && parts[2] === "A")) {
                lastValidFixMs = control.millis();
            }
        }
    }

    function parseGSV(line: string): void {
        let parts = line.split(",");
        if (parts.length < 8) return;

        let talker = parts[0].substr(1, 2);
        let isBDS = (talker === "BD" || talker === "GB");

        let idx = 4;
        let satellites = isBDS ? bdsSatellites : gpsSatellites;

        while (idx + 3 < parts.length) {
            let idRaw = parts[idx++];
            let elvRaw = parts[idx++];
            let azRaw = parts[idx++];
            let snrRaw = parts[idx++];

            if (!idRaw) continue;  // Changed: Only skip if no ID; allow empty SNR

            let id = parseInt(idRaw);
            let elv = parseInt(elvRaw) || 0;
            let az = parseInt(azRaw) || 0;
            let snr = parseInt(snrRaw) || 0;  // Changed: Default to 0 if empty or invalid

            if (id > 0) {  // Changed: Remove '&& snr > 0' to include low/zero SNR satellites
                let sat: Satellite = { id: id, elevation: elv, azimuth: az, snr: snr };

                let pos = -1;
                for (let i = 0; i < satellites.length; i++) {
                    if (satellites[i].id === id) {
                        pos = i;
                        break;
                    }
                }

                if (pos >= 0) {
                    satellites[pos] = sat;
                } else {
                    satellites.push(sat);
                }
            }
        }

        // Limit list size (memory safety on micro:bit)
        if (satellites.length > 32) {
            satellites = satellites.slice(-28);
        }
    }

    // -------------------------------------------------------------------------
    // Status & position getters (return formatted strings)
    // -------------------------------------------------------------------------

    /**
     * GNSS working status: "outdoor" or "indoor"
     */
    //% block="GNSS status"
    //% group="GNSS" weight=70
    export function status(): string {
        // Prefer direct sentence evidence first
        let fixGGA = extractField(lastGGA, 6);
        if (fixGGA === "1" || fixGGA === "2" || fixGGA === "4") {
            lastValidFixMs = control.millis();  // update timestamp here too
            return "outdoor";
        }

        let fixRMC = extractField(lastRMC, 2);
        if (fixRMC === "A") {
            lastValidFixMs = control.millis();
            return "outdoor";
        }

        // Age-based fallback only if no recent sentence evidence
        let age = control.millis() - lastValidFixMs;
        if (age > 12000) return "indoor";  // more lenient than 8s

        // Satellite fallback (only used if sentences are old)
        let total = gpsSatellites.length + bdsSatellites.length;
        let good = 0;
        for (let s of gpsSatellites) if (s.snr >= 28) good++;  // slightly lower threshold
        for (let s of bdsSatellites) if (s.snr >= 28) good++;

        return (total >= 5 && good >= 3) ? "outdoor" : "indoor";
    }

    /**
     * UTC time HH:MM:SS or empty string
     */
    //% block="UTC time"
    //% group="GNSS"
    export function utcTime(): string {
        let t = extractField(lastGGA, 1) || extractField(lastRMC, 1);
        if (!t || t.length < 6) return "";
        let hh = t.substr(0, 2);
        let mm = t.substr(2, 2);
        let ss = t.substr(4, 2);
        return hh + ":" + mm + ":" + ss;
    }

    /**
     * Latitude with 6 decimal places or "(no fix)"
     */
    //% block="latitude"
    //% group="GNSS"
    export function latitude(): string {
        if (status() !== "outdoor") return "(no fix)";

        let raw = extractField(lastGGA, 2) || extractField(lastRMC, 3);
        if (!raw || raw.length < 4) return "(no fix)";

        let deg = parseInt(raw.substr(0, 2));
        let min = parseFloat(raw.substr(2));
        let dec = deg + min / 60;

        let ns = extractField(lastGGA, 3) || extractField(lastRMC, 4);
        if (ns === "S") dec = -dec;

        return "" + (Math.round(dec * 1000000) / 1000000);
    }

    /**
     * Longitude with 6 decimal places or "(no fix)"
     */
    //% block="longitude"
    //% group="GNSS"
    export function longitude(): string {
        if (status() !== "outdoor") return "(no fix)";

        let raw = extractField(lastGGA, 4) || extractField(lastRMC, 5);
        if (!raw || raw.length < 5) return "(no fix)";

        let deg = parseInt(raw.substr(0, 3));
        let min = parseFloat(raw.substr(3));
        let dec = deg + min / 60;

        let ew = extractField(lastGGA, 5) || extractField(lastRMC, 6);
        if (ew === "W") dec = -dec;

        return "" + (Math.round(dec * 1000000) / 1000000);
    }

    /**
     * Speed in km/h with 1 decimal place or "(no fix)"
     */
    //% block="speed (km/h)"
    //% group="GNSS"
    export function speedKmh(): string {
        if (status() !== "outdoor") return "(no fix)";

        let vtg = extractField(lastVTG, 7);
        if (vtg && vtg !== "") {
            let v = parseFloat(vtg);
            return "" + (Math.round(v * 10) / 10);
        }

        let rmc = extractField(lastRMC, 7);
        if (rmc && rmc !== "") {
            let v = parseFloat(rmc) * 1.852;
            return "" + (Math.round(v * 10) / 10);
        }

        return "(no fix)";
    }

    // -------------------------------------------------------------------------
    // Satellite information
    // -------------------------------------------------------------------------
    //% block="debugDumpSatellites $isBeiDou"
    //% group="Satellites"
    //% advanced=true
    export function debugDumpSatellites(isBeiDou: boolean = true): string {
        const sats = isBeiDou ? bdsSatellites : gpsSatellites;
        let dump = "";
        for (let i = 0; i < sats.length; i++) {
            const s = sats[i];
            dump += "Index " + i + ": ID=" + s.id + ", el=" + s.elevation + ", az=" + s.azimuth + ", snr=" + s.snr + "\n";
        }
        return dump || "Empty array";
    }

    //% block="number of Beidou Satellites $isBeiDou""
    //% group="Satellites"
    export function satelliteCount(isBeiDou: boolean = true): number {
        const len = isBeiDou ? bdsSatellites.length : bdsSatellites.length;
        return len;
    }

    //% block="Beidou Satellite info $index $isBeiDou""
    //% group="Satellites"
    export function satelliteInfo(index: number, isBeiDou: boolean = true): string {
        const sats = isBeiDou ? bdsSatellites : gpsSatellites;

        if (index < 0 || index >= sats.length) {
            return "—";
        }

        let s = sats[index];

        return "ID: " + s.id.toString() + " El: " + s.elevation.toString() + "deg Az: " + s.azimuth.toString() + "deg SNR: " + s.snr.toString() + "dB";
    }

    /**
     * Returns the formatted satellite PRN string.
     * @param index The index in the satellites array
     * @param isBeiDou Whether to use BeiDou (bdsSatellites) instead of GPS
     * @returns Formatted PRN (e.g., "ID 12") or "—" if invalid
     */
    //% block="Beidou satellitePRN $index $isBeiDou""
    //% group="Satellites"
    export function satelliteId(index: number, isBeiDou: boolean = true): string {
        const sats = isBeiDou ? bdsSatellites : gpsSatellites;
        if (index < 0 || index >= sats.length) return "—";
        const id = sats[index].id;
        return id.toString();
    }

    /**
     * Returns the formatted altitude string.
     * @param index The index in the satellites array
     * @param isBeiDou Whether to use BeiDou array
     * @returns Formatted altitude (e.g., "el:65°") or "—" if invalid
     */
    //% block="Beidou satellite Altitude $index $isBeiDou""
    //% group="Satellites"
    export function satelliteElevation(index: number, isBeiDou: boolean = true): string {
        const sats = isBeiDou ? bdsSatellites : gpsSatellites;
        if (index < 0 || index >= sats.length) return "—";
        const el = sats[index].elevation;
        return el.toString();
    }

    /**
     * Returns the formatted azimuth string.
     * @param index The index in the satellites array
     * @param isBeiDou Whether to use BeiDou array
     * @returns Formatted azimuth (e.g., "az:220°") or "—" if invalid
     */
    //% block="Beidou satellite Azimuth $index $isBeiDou""
    //% group="Satellites"
    export function satelliteAzimuth(index: number, isBeiDou: boolean = true): string {
        const sats = isBeiDou ? bdsSatellites : gpsSatellites;
        if (index < 0 || index >= sats.length) return "—";
        const az = sats[index].azimuth;
        return az.toString();
    }

    /**
     * Returns the formatted SNR string.
     * @param index The index in the satellites array
     * @param isBeiDou Whether to use BeiDou array
     * @returns Formatted SNR (e.g., "38dB") or "—" if invalid
     */
    //% block="Beidou satellite SNR $index $isBeiDou""
    //% group="Satellites"
    export function satelliteSnr(index: number, isBeiDou: boolean = true): string {
        const sats = isBeiDou ? bdsSatellites : gpsSatellites;
        if (index < 0 || index >= sats.length) return "—";
        const snr = sats[index].snr;
        return snr.toString();
    }
    // -------------------------------------------------------------------------
    // Raw NMEA sentences (last received)
    // -------------------------------------------------------------------------

    //% block="raw GGA"
    //% group="Raw NMEA" weight=60
    //% advanced=true
    export function rawGGA(): string {
        return lastGGA || "";
    }

    //% block="raw RMC"
    //% group="Raw NMEA" weight=59
    //% advanced=true
    export function rawRMC(): string {
        return lastRMC || "";
    }

    //% block="raw VTG"
    //% group="Raw NMEA" weight=58
    //% advanced=true
    export function rawVTG(): string {
        return lastVTG || "";
    }

    //% block="raw GSA (last)"
    //% group="Raw NMEA" weight=57
    //% advanced=true
    export function rawGSA(): string {
        return lastGSA || "";
    }

    //% block="raw GSV (last received)"
    //% group="Raw NMEA" weight=56
    //% advanced=true
    export function rawGSV(): string {
        return lastGSV || "";
    }

    // -------------------------------------------------------------------------
    // Utility
    // -------------------------------------------------------------------------

    function extractField(sentence: string, idx: number): string {
        if (!sentence) return "";
        let p = sentence.split(",");
        return idx < p.length ? p[idx] : "";
    }

    //% block="clear satellite lists"
    //% group="GNSS" advanced=true
    export function clearSatellites(): void {
        gpsSatellites = [];
        bdsSatellites = [];
    }
    // ────────────────────────────────────────────────
    // Robust padStart polyfill for MakeCode runtime
    // ────────────────────────────────────────────────
    function padStart(str: string, targetLength: number, padChar: string = " "): string {
        // Handle null/undefined input
        if (str === undefined || str === null) {
            str = "0";
        }

        // Convert to string if not already
        //str = String(str);

        // Handle invalid arguments
        if (targetLength <= 0) {
            return str;
        }

        if (padChar === undefined || padChar === null) {
            padChar = " ";
        }
        //padChar = String(padChar);

        if (str.length >= targetLength) {
            return str;
        }

        const paddingNeeded = targetLength - str.length;
        let padding = "";

        // Build padding efficiently
        while (padding.length < paddingNeeded) {
            if (padding.length + padChar.length <= paddingNeeded) {
                padding += padChar;
            } else {
                padding += padChar.slice(0, paddingNeeded - padding.length);
            }
        }

        return padding + str;
    }
}
