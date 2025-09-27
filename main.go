package main

import (
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Scoreboard struct {
	HomeName       string `json:"homeName"`
	HomeLogo       string `json:"homeLogo"`
	HomeScore      int    `json:"homeScore"`
	AwayName       string `json:"awayName"`
	AwayLogo       string `json:"awayLogo"`
	AwayScore      int    `json:"awayScore"`
	Timer          string `json:"timer"`
	Running        bool   `json:"running"`
	HalfLength     int    `json:"halfLength"` // v minutách
	Theme          string `json:"theme"`
	HomeShort      string `json:"homeShort"`
	AwayShort      string `json:"awayShort"`
	PrimaryColor   string `json:"primaryColor"`
	SecondaryColor string `json:"secondaryColor"`
    SidesFlipped   bool   `json:"sidesFlipped"`
    Half           int    `json:"half"`
}

// saveHandler saves current state to saved/<filename>.json
// Accepts: POST JSON {"filename":"custom-name"} or query ?filename=custom-name
// If filename is empty, uses timestamp "state-YYYYMMDD-HHMMSS.json"
func saveHandler(w http.ResponseWriter, r *http.Request) {
    type req struct{ Filename string `json:"filename"` }
    q := req{ Filename: r.URL.Query().Get("filename") }
    if q.Filename == "" && r.Body != nil {
        _ = json.NewDecoder(r.Body).Decode(&q)
    }
    name := sanitizeFilename(q.Filename)
    if name == "" {
        name = time.Now().Format("20060102-150405")
    }
    if !strings.HasSuffix(strings.ToLower(name), ".json") {
        name += ".json"
    }
    path := "saved/" + name
    stateMu.Lock()
    data, _ := json.MarshalIndent(state, "", "  ")
    stateMu.Unlock()
    if err := os.WriteFile(path, data, 0644); err != nil {
        http.Error(w, "Uložení selhalo", http.StatusInternalServerError)
        return
    }
    w.Header().Set("Content-Type", "application/json")
    io.WriteString(w, fmt.Sprintf(`{"saved":"%s"}`, name))
}

// listSavesHandler returns list of .json files in /saved
func listSavesHandler(w http.ResponseWriter, r *http.Request) {
    entries, err := os.ReadDir("saved")
    if err != nil {
        http.Error(w, "Nelze číst složku saved", http.StatusInternalServerError)
        return
    }
    var out []string
    for _, e := range entries {
        if e.IsDir() { continue }
        name := e.Name()
        if strings.HasSuffix(strings.ToLower(name), ".json") {
            out = append(out, name)
        }
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(out)
}

// loadSavedHandler loads state from /saved/<filename>
func loadSavedHandler(w http.ResponseWriter, r *http.Request) {
    filename := sanitizeFilename(r.URL.Query().Get("filename"))
    if filename == "" {
        http.Error(w, "Chybí parametr filename", http.StatusBadRequest)
        return
    }
    if !strings.HasSuffix(strings.ToLower(filename), ".json") {
        filename += ".json"
    }
    path := "saved/" + filename
    data, err := os.ReadFile(path)
    if err != nil {
        http.Error(w, "Soubor nenalezen", http.StatusNotFound)
        return
    }
    var imported Scoreboard
    if err := json.Unmarshal(data, &imported); err != nil {
        http.Error(w, "Neplatný JSON", http.StatusBadRequest)
        return
    }
    // Přepiš stav jako v importHandler
    stateMu.Lock()
    state = imported
    // Defaults for older saves
    if state.Half <= 0 { state.Half = 1 }
    if strings.TrimSpace(state.HomeShort) == "" {
        state.HomeShort = makeShort(state.HomeName)
    }
    if strings.TrimSpace(state.AwayShort) == "" {
        state.AwayShort = makeShort(state.AwayName)
    }
    elapsedSeconds = parseTimerToSeconds(state.Timer)
    if state.Running {
        startTime = time.Now().Add(-time.Duration(elapsedSeconds) * time.Second)
    } else {
        startTime = time.Time{}
    }
    stateMu.Unlock()
    broadcast()
    w.WriteHeader(http.StatusOK)
}

// swapSidesHandler toggles visual sides flipping only. It does NOT swap team data.
func swapSidesHandler(w http.ResponseWriter, r *http.Request) {
    stateMu.Lock()
    state.SidesFlipped = !state.SidesFlipped
    stateMu.Unlock()
    broadcast()
    w.WriteHeader(http.StatusOK)
}

// startSecondHalfHandler flips sides visually for second half and continues timer from end of 1st half.
func startSecondHalfHandler(w http.ResponseWriter, r *http.Request) {
    stateMu.Lock()
    // Flip visually only
    state.SidesFlipped = !state.SidesFlipped
    // Move to second half and continue from end of first half
    state.Half = 2
    // Ensure elapsedSeconds reflects end of first half
    if elapsedSeconds < state.HalfLength*60 {
        elapsedSeconds = state.HalfLength * 60
    }
    startTime = time.Now().Add(-time.Duration(elapsedSeconds) * time.Second)
    state.Running = true
    state.Timer = fmt.Sprintf("%02d:%02d", elapsedSeconds/60, elapsedSeconds%60)
    stateMu.Unlock()
    broadcast()
    w.WriteHeader(http.StatusOK)
}

// sanitizeFilename keeps only [a-zA-Z0-9-_] and dots, strips path separators
func sanitizeFilename(in string) string {
    in = strings.TrimSpace(in)
    in = strings.ReplaceAll(in, "\\", "")
    in = strings.ReplaceAll(in, "/", "")
    var b strings.Builder
    for _, r := range in {
        if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
            b.WriteRune(r)
        }
    }
    return b.String()
}
// deriveColorsHandler derives average colors from provided image URLs.
// Usage:
// - /api/colors/derive?url=<one-url> -> {"color":"#RRGGBB"}
// - /api/colors/derive?homeLogo=<url>&awayLogo=<url> -> {"primaryColor":"#..","secondaryColor":"#.."}
// Also supports JSON body: {"homeLogo":"...","awayLogo":"..."} or {"url":"..."}
func deriveColorsHandler(w http.ResponseWriter, r *http.Request) {
    type req struct{
        URL string `json:"url"`
        HomeLogo string `json:"homeLogo"`
        AwayLogo string `json:"awayLogo"`
    }
    type singleResp struct{ Color string `json:"color"` }
    type duoResp struct{ PrimaryColor string `json:"primaryColor"`; SecondaryColor string `json:"secondaryColor"` }

    q := req{
        URL: r.URL.Query().Get("url"),
        HomeLogo: r.URL.Query().Get("homeLogo"),
        AwayLogo: r.URL.Query().Get("awayLogo"),
    }
    // If no query params, try JSON body
    if q.URL == "" && q.HomeLogo == "" && q.AwayLogo == "" && r.Body != nil {
        _ = json.NewDecoder(r.Body).Decode(&q)
    }

    w.Header().Set("Content-Type", "application/json")

    if q.URL != "" {
        col, err := averageColorFromURL(q.URL)
        if err != nil {
            http.Error(w, "Nelze načíst obrázek nebo vypočítat barvu.", http.StatusBadRequest)
            return
        }
        json.NewEncoder(w).Encode(singleResp{Color: col})
        return
    }

    if q.HomeLogo != "" || q.AwayLogo != "" {
        var primary, secondary string
        if q.HomeLogo != "" {
            if col, err := averageColorFromURL(q.HomeLogo); err == nil {
                primary = col
            }
        }
        if q.AwayLogo != "" {
            if col, err := averageColorFromURL(q.AwayLogo); err == nil {
                secondary = col
            }
        }
        json.NewEncoder(w).Encode(duoResp{PrimaryColor: primary, SecondaryColor: secondary})
        return
    }

    http.Error(w, "Zadejte prosím ?url= nebo ?homeLogo=&awayLogo=.", http.StatusBadRequest)
}

func averageColorFromURL(u string) (string, error) {
    resp, err := httpClient.Get(u)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        return "", fmt.Errorf("http status %d", resp.StatusCode)
    }
    img, _, err := image.Decode(resp.Body)
    if err != nil {
        return "", err
    }
    return averageHex(img), nil
}

func averageHex(img image.Image) string {
    rect := img.Bounds()
    if rect.Empty() { return "#000000" }
    w := rect.Dx(); h := rect.Dy()
    // sample grid to limit work
    stepX := 1
    stepY := 1
    // aim up to ~160k samples
    for (w/stepX)*(h/stepY) > 160000 {
        if stepX <= stepY { stepX *= 2 } else { stepY *= 2 }
    }
    var rsum, gsum, bsum, count uint64
    for y := rect.Min.Y; y < rect.Max.Y; y += stepY {
        for x := rect.Min.X; x < rect.Max.X; x += stepX {
            cr, cg, cb, ca := img.At(x,y).RGBA()
            if ca < 0x2000 { // skip mostly transparent
                continue
            }
            // RGBA returns 16-bit, convert to 8-bit
            rsum += uint64(cr >> 8)
            gsum += uint64(cg >> 8)
            bsum += uint64(cb >> 8)
            count++
        }
    }
    if count == 0 { return "#000000" }
    r8 := uint8(rsum / count)
    g8 := uint8(gsum / count)
    b8 := uint8(bsum / count)
    return fmt.Sprintf("#%02x%02x%02x", r8, g8, b8)
}

// makeShort derives a 3-letter uppercase abbreviation from a club name.
// Handles basic Czech diacritics by mapping to ASCII and strips non-letters.
func makeShort(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "---"
	}
	name = strings.ToUpper(name)
	repl := strings.NewReplacer(
		"Á", "A", "Ä", "A", "Å", "A", "Â", "A", "À", "A",
		"Č", "C", "Ć", "C", "Ç", "C",
		"Ď", "D",
		"É", "E", "Ě", "E", "È", "E", "Ë", "E", "Ê", "E",
		"Í", "I", "Ì", "I", "Ï", "I", "Î", "I",
		"Ň", "N", "Ń", "N",
		"Ó", "O", "Ö", "O", "Ô", "O", "Ò", "O",
		"Ř", "R",
		"Š", "S", "Ś", "S",
		"Ť", "T",
		"Ú", "U", "Ů", "U", "Ù", "U", "Ü", "U", "Û", "U",
		"Ý", "Y",
		"Ž", "Z",
	)
	name = repl.Replace(name)
	out := make([]rune, 0, 3)
	for _, r := range name {
		if r >= 'A' && r <= 'Z' {
			out = append(out, r)
			if len(out) == 3 {
				break
			}
		}
	}
	for len(out) < 3 {
		out = append(out, '-')
	}
	return string(out)
}

var state = Scoreboard{
	HomeName:       "Domácí",
	HomeLogo:       "",
	HomeScore:      0,
	AwayName:       "Hosté",
	AwayLogo:       "",
	AwayScore:      0,
	Timer:          "00:00",
	Running:        false,
	HalfLength:     45,
	Theme:          "pill",
	HomeShort:      "DOM",
	AwayShort:      "HOS",
	PrimaryColor:   "#1e3a8a",
	SecondaryColor: "#2563eb",
    SidesFlipped:   false,
    Half:           1,
}

var clients = make(map[chan string]bool)
var mu sync.Mutex
var stateMu sync.Mutex

var startTime time.Time // kdy byl timer naposledy spuštěn
var elapsedSeconds int  // kolik sekund už uběhlo (přičítá se od startTime)
var httpClient = &http.Client{Timeout: 7 * time.Second}

func main() {
    // ensure saved directory exists
    _ = os.MkdirAll("saved", 0755)
	http.Handle("/", http.FileServer(http.Dir("static")))
	// Serve control UI from /ovladani/
	http.Handle("/ovladani/", http.StripPrefix("/ovladani/", http.FileServer(http.Dir("ovladani"))))
	// Serve saved files for download/inspection
	http.Handle("/saved/", http.StripPrefix("/saved/", http.FileServer(http.Dir("saved"))))
	// Convenience redirect from /ovladani to /ovladani/
	http.HandleFunc("/ovladani", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ovladani/", http.StatusMovedPermanently)
	})
	http.HandleFunc("/api/state", getState)
	http.HandleFunc("/api/update", updateState)
	http.HandleFunc("/api/stream", stream)
	http.HandleFunc("/api/timer/start", startTimerHandler)
	http.HandleFunc("/api/timer/pause", pauseTimerHandler)
	http.HandleFunc("/api/timer/reset", resetTimerHandler)
	http.HandleFunc("/api/import", importHandler)
	http.HandleFunc("/api/export", exportHandler)
	http.HandleFunc("/api/colors/derive", deriveColorsHandler)
	http.HandleFunc("/api/save", saveHandler)
	http.HandleFunc("/api/saves", listSavesHandler)
	http.HandleFunc("/api/load", loadSavedHandler)
	// New: swap sides and start second half
	http.HandleFunc("/api/swapSides", swapSidesHandler)
	http.HandleFunc("/api/timer/secondHalf", startSecondHalfHandler)

	fmt.Println("Server běží na http://localhost:5000")
	go timerLoop()
	log.Fatal(http.ListenAndServe(":5000", nil))
}

// vrátí aktuální stav
func getState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	stateMu.Lock()
	defer stateMu.Unlock()
	json.NewEncoder(w).Encode(state)
}

// exportHandler returns current state as a downloadable JSON file
func exportHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", "attachment; filename=scoreboard-state.json")
	stateMu.Lock()
	defer stateMu.Unlock()
	json.NewEncoder(w).Encode(state)
}

// přijme update z admin panelu
func updateState(w http.ResponseWriter, r *http.Request) {
	var newState Scoreboard
	err := json.NewDecoder(r.Body).Decode(&newState)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Aktualizujeme pouze relevantní pole (vyjma řízení timeru)
	stateMu.Lock()
	state.HomeName = newState.HomeName
	state.HomeLogo = newState.HomeLogo
	state.AwayName = newState.AwayName
	state.AwayLogo = newState.AwayLogo
	state.HomeScore = newState.HomeScore
	state.AwayScore = newState.AwayScore
	state.HalfLength = newState.HalfLength
	state.Theme = newState.Theme
    // derive 3-letter shorts from names when not provided or invalid
    hs := strings.ToUpper(strings.TrimSpace(newState.HomeShort))
    as := strings.ToUpper(strings.TrimSpace(newState.AwayShort))
    valid := func(s string) bool {
        if len(s) != 3 { return false }
        for i := 0; i < 3; i++ {
            c := s[i]
            if c < 'A' || c > 'Z' { return false }
        }
        return true
    }
    if valid(hs) {
        state.HomeShort = hs
    } else {
        state.HomeShort = makeShort(state.HomeName)
    }
    if valid(as) {
        state.AwayShort = as
    } else {
        state.AwayShort = makeShort(state.AwayName)
    }
	if newState.PrimaryColor != "" {
		state.PrimaryColor = newState.PrimaryColor
	}
	if newState.SecondaryColor != "" {
		state.SecondaryColor = newState.SecondaryColor
	}
	// Timer a Running se řídí přes dedikované endpointy
	stateMu.Unlock()

	broadcast()
	w.WriteHeader(http.StatusOK)
}

// SSE stream pro overlay
func stream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan string)
	mu.Lock()
	clients[ch] = true
	mu.Unlock()

	defer func() {
		mu.Lock()
		delete(clients, ch)
		mu.Unlock()
		close(ch)
	}()

	// po připojení rovnou pošleme aktuální stav
	stateMu.Lock()
	initial, _ := json.Marshal(state)
	stateMu.Unlock()
	fmt.Fprintf(w, "data: %s\n\n", initial)
	w.(http.Flusher).Flush()

	for msg := range ch {
		fmt.Fprintf(w, "data: %s\n\n", msg)
		w.(http.Flusher).Flush()
	}
}

func broadcast() {
	stateMu.Lock()
	data, _ := json.Marshal(state)
	stateMu.Unlock()
	mu.Lock()
	defer mu.Unlock()
	for ch := range clients {
		ch <- string(data)
	}
}

// --- Timer backend ---

func timerLoop() {
    // Higher-frequency ticker to reduce perceived start latency and update when the second actually changes
    ticker := time.NewTicker(200 * time.Millisecond)
    defer ticker.Stop()
    lastSecond := -1
    wasRunning := false
    for range ticker.C {
        stateMu.Lock()
        if state.Running {
            // přepočet uplynulého času od startu
            elapsed := time.Since(startTime).Seconds()
            if elapsed < 0 {
                elapsed = 0
            }
            sec := int(elapsed)
            // kontrola konce dle aktuálního poločasu
            maxSeconds := state.HalfLength * 60
            if state.Half >= 2 {
                maxSeconds = state.HalfLength * 120
            }
            if sec >= maxSeconds {
                state.Running = false
                sec = maxSeconds
            }
            // update only when integer seconds changed or when just started running
            if sec != lastSecond || !wasRunning {
                elapsedSeconds = sec
                state.Timer = fmt.Sprintf("%02d:%02d", elapsedSeconds/60, elapsedSeconds%60)
                stateMu.Unlock()
                broadcast()
                lastSecond = sec
                wasRunning = true
                continue
            }
            wasRunning = true
            stateMu.Unlock()
            continue
        }
        // not running
        wasRunning = false
        lastSecond = -1
        stateMu.Unlock()
    }
}

func parseTimerToSeconds(timer string) int {
    // očekáváme tvar MM:SS
    parts := strings.Split(timer, ":")
    if len(parts) != 2 {
        return 0
    }
    m, err1 := strconv.Atoi(parts[0])
    s, err2 := strconv.Atoi(parts[1])
    if err1 != nil || err2 != nil || m < 0 || s < 0 || s >= 60 {
        return 0
    }
    return m*60 + s
}

func startTimerHandler(w http.ResponseWriter, r *http.Request) {
    stateMu.Lock()
    // pokud máme nějaký existující čas na state.Timer, vezmeme ho jako výchozí offset
    if state.Timer != "" {
        elapsedSeconds = parseTimerToSeconds(state.Timer)
    }
    startTime = time.Now().Add(-time.Duration(elapsedSeconds) * time.Second)
    if state.Half <= 0 { state.Half = 1 }
    state.Running = true
    // emit immediate update so UI reflects running state without waiting for next tick
    state.Timer = fmt.Sprintf("%02d:%02d", elapsedSeconds/60, elapsedSeconds%60)
    stateMu.Unlock()
    broadcast()
    w.WriteHeader(http.StatusOK)
}

func pauseTimerHandler(w http.ResponseWriter, r *http.Request) {
    stateMu.Lock()
    // fixujeme dosavadní elapsedSeconds
    if state.Running {
        elapsed := time.Since(startTime).Seconds()
        if elapsed < 0 {
            elapsed = 0
        }
        elapsedSeconds = int(elapsed)
    }
    state.Running = false
    // zaktualizujeme zobrazený čas
    state.Timer = fmt.Sprintf("%02d:%02d", elapsedSeconds/60, elapsedSeconds%60)
    stateMu.Unlock()
    broadcast()
    w.WriteHeader(http.StatusOK)
}

func resetTimerHandler(w http.ResponseWriter, r *http.Request) {
	stateMu.Lock()
	state.Running = false
	elapsedSeconds = 0
	startTime = time.Time{}
	state.Timer = "00:00"
    state.Half = 1
	stateMu.Unlock()
	broadcast()
	w.WriteHeader(http.StatusOK)
}

// --- Import dat ---
func importHandler(w http.ResponseWriter, r *http.Request) {
	// Podpora multipart uploadu i přímého JSON body
	var data []byte
	var err error

	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		file, _, ferr := r.FormFile("file")
		if ferr != nil {
			http.Error(w, "Soubor nebyl nahrán (pole 'file').", http.StatusBadRequest)
			return
		}
		defer file.Close()
		data, err = io.ReadAll(file)
		if err != nil {
			http.Error(w, "Chyba čtení souboru.", http.StatusBadRequest)
			return
		}
	} else {
		data, err = io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "Chyba čtení požadavku.", http.StatusBadRequest)
			return
		}
	}

	var imported Scoreboard
	if err := json.Unmarshal(data, &imported); err != nil {
		http.Error(w, "Neplatný JSON.", http.StatusBadRequest)
		return
	}

	// Přepíšeme stav a správně nastavíme timer
	stateMu.Lock()
	state = imported
	// Defaults for older saves
	if state.Half <= 0 { state.Half = 1 }
	// pokud chybí zkratky, odvoď je ze jmen
	if strings.TrimSpace(state.HomeShort) == "" {
		state.HomeShort = makeShort(state.HomeName)
	}
	if strings.TrimSpace(state.AwayShort) == "" {
		state.AwayShort = makeShort(state.AwayName)
	}
	// aktualizace interních proměnných timeru
	elapsedSeconds = parseTimerToSeconds(state.Timer)
	if state.Running {
		// nastavíme startTime tak, aby navazoval na importovaný čas
		startTime = time.Now().Add(-time.Duration(elapsedSeconds) * time.Second)
	} else {
		startTime = time.Time{}
	}
	stateMu.Unlock()

	broadcast()
	w.WriteHeader(http.StatusOK)
}
