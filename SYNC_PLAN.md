# Synchronizacja postępu eksploracji — scout i plan implementacji

### 1. Current architecture

Random Frame to aplikacja Tauri 2: TypeScript steruje widokiem, a Rust wybiera ID, pobiera stronę i obraz prnt.sc oraz zapisuje dane. Losowanie już korzysta z lokalnego rejestru eksploracji, więc punkt wpięcia dla synchronizacji istnieje. Trzeba jednak rozdzielić „obraz obejrzany” od „ID sprawdzone”: obecny rejestr zawiera również odrzucone ID i oznacza udane pobranie jako obejrzane, zanim frontend potwierdzi, że obraz da się wyświetlić.

Nie ma obecnie serwera sync, kont, bazy danych ani magazynu sekretów. Dane aplikacji są w plikach katalogu Tauri `app_data_dir`.

### 2. Relevant files

| File | Responsibility | Relevance to sync |
|---|---|---|
| [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs#L24) | `AppState`, komendy Tauri, retry, startup | Miejsce podłączenia stanu sync i nowych komend; `clear_history` usuwa dziś także eksplorację. |
| [`src-tauri/src/sources/mod.rs`](src-tauri/src/sources/mod.rs#L6) | Wybór źródła i `mixed` | `mixed` wybiera obecnie wyłącznie dostępne prnt.sc. |
| [`src-tauri/src/sources/prntsc.rs`](src-tauri/src/sources/prntsc.rs#L91) | Losowanie, pobranie, klasyfikacja, wykluczanie ID | Główny punkt sprawdzania `seen`; obecny limit 32 prób może zwrócić znane ID. |
| [`src-tauri/src/sources/prntsc/id.rs`](src-tauri/src/sources/prntsc/id.rs#L6) | Generator i parser legacy base-36 | ID już konwertowane są na `u64`; zakres kończy się na `26y3ahr`. |
| [`src-tauri/src/persistence.rs`](src-tauri/src/persistence.rs#L47) | Historia, ulubione, eksploracja, statystyki | Właściciel lokalnych plików i wzorzec trwałego zapisu. |
| [`src-tauri/src/error.rs`](src-tauri/src/error.rs#L5) | Typowane błędy Tauri | Potrzebne rozróżnienie błędów sync, konfliktu i błędnego klucza. |
| [`src/client/api.ts`](src/client/api.ts#L21) | Dwuetapowe pobranie metadanych i bajtów | Udany fetch w Rust nie oznacza jeszcze wyświetlenia. |
| [`src/client/frame-loader.ts`](src/client/frame-loader.ts#L23) | Draw, wejście po ID, historia i sąsiednie ID | Po dekodowaniu zapisuje nową ramkę w historii i pokazuje ją. |
| [`src/client/stage.ts`](src/client/stage.ts#L173) | Dekodowanie, stan widoku, pokazanie obrazu | `decodedUrl` jest granicą między pobranym a możliwym do pokazania obrazem. |
| [`src/client/app.ts`](src/client/app.ts#L27) | Inicjalizacja frontendu i przywrócenie ramki | Miejsce uruchomienia sync przy starcie bez blokowania widoku. |
| [`src/client/persistence.ts`](src/client/persistence.ts#L34) | Wywołania komend persistence | Wzorzec dla cienkiego API sync w frontendzie. |
| [`src/client/viewer-state.ts`](src/client/viewer-state.ts#L7) | Stan runtime widoku | Powinien znać co najwyżej status sync, nie cały zbiór ID ani sekret. |
| [`src/client/frame-cache.ts`](src/client/frame-cache.ts#L8) | Bloby i miniatury | Cache pozostaje lokalny; miniatury mają limit 300 wpisów. |
| [`src/client/history-dialog.ts`](src/client/history-dialog.ts#L126) | Czyszczenie historii | UX musi wyjaśniać, że czyszczenie historii nie cofa `seen`. |
| [`src/client/navigation.ts`](src/client/navigation.ts#L38) | Sąsiednie legacy ID i pozycje historii | Jawna nawigacja ma nadal pozwalać otworzyć znane ID. |
| [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml#L20) | Zależności Rust | Jest `reqwest` i `rand`; nie ma bezpośrednich zależności HKDF, AEAD ani secure storage. |
| [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json#L25) | Konfiguracja Tauri i CSP | Sieć prowadzona przez Rust nie wymaga dostępu HTTP z webview. |
| [`index.html`](index.html#L45) | Dialogi i przyciski | Miejsce minimalnego wejścia do ustawień Sync. |
| [`privacy.html`](privacy.html#L88) | Obecna deklaracja prywatności | Twierdzenie o braku transmisji danych do własnego serwera wymaga aktualizacji przed wydaniem sync. |

### 3. Current frame lifecycle

1. `loadRandom()` wywołuje `getRandomFrame()`; frontend domyślnie podaje `prntsc` (`src/client/frame-loader.ts:37`, `src/client/api.ts:39`).
2. Komenda Rust wybiera źródło, pobiera token limitera i uruchamia pętlę retry. `mixed` losuje spośród dostępnych źródeł, czyli dziś tylko prnt.sc (`src-tauri/src/lib.rs:126`, `src-tauri/src/sources/mod.rs:31`).
3. `Prntsc::get_random_frame()` losuje legacy ID, sprawdza je w `ExplorationStore`, pobiera HTML, wydobywa adres obrazu i pobiera bajty (`src-tauri/src/sources/prntsc.rs:91`).
4. `Prntsc::get_frame()` już tutaj zapisuje `Viewed` po udanym pobraniu albo `Rejected` dla sklasyfikowanej niedostępności. Błąd sieci, timeout, 403/429 i błąd serwera nie stają się wpisem eksploracji (`src-tauri/src/sources/prntsc.rs:96`, `src-tauri/src/error.rs:73`).
5. Metadane wracają do frontendu, a bajty przechodzą przez jednowpisowy `PendingFrame` i osobne `get_frame_image` (`src-tauri/src/lib.rs:66`, `src/client/api.ts:21`).
6. `recordFrame()` dekoduje `Blob`, zapisuje `HistoryItem`, a następnie wykonuje `showFrame()` (`src/client/frame-loader.ts:23`). Obraz, który nie przejdzie `img.decode()`, nie trafia do historii ani na scenę (`src/client/stage.ts:173`).

Wynik praktyczny: 404 i odrzucony obraz są dziś pomijane przez przyszłe losowania lokalne, choć użytkownik ich nie zobaczył. Obraz pobrany poprawnie, lecz niedekodowalny, może być błędnie zapisany jako `Viewed`. Nieudany fetch sieciowy nie jest zapisywany. Szybkie przejście do kolejnej ramki blokuje `state.loading`, ale zamknięcie aplikacji między pobraniem a pokazaniem nadal ujawnia tę różnicę semantyczną.

`goTo()` obsługuje back/next, skok do pozycji i wybór z historii; korzysta z bloba albo ponownie pobiera obraz, lecz nie dodaje nowej pozycji historii (`src/client/frame-loader.ts:55`). Sąsiednie ID i ręcznie podane ID przechodzą przez `loadById()`; jeśli nie ma ich w historii, dołączają do niej jako nowy wpis (`src/client/frame-loader.ts:104`). Te jawne działania mogą otworzyć znany frame — blokada powtórek powinna dotyczyć losowania.

### 4. Current persistence model

- `history.json`: JSON z tablicą `{source, id, sourcePageUrl, viewedAt}` i bieżącym indeksem. Powtórne otwarcie tego samego ID aktualizuje wpis, a każda zmiana klonuje i zapisuje całą historię (`src-tauri/src/persistence.rs:56`).
- `prntsc-explored.txt`: dopisywane wiersze `liczbowe_id,v` lub `liczbowe_id,r`; starsze wiersze zawierają samą liczbę. W pamięci to `HashMap<u64, ExplorationClass>`, obejmujący obejrzane, odrzucone i legacy `Unknown` (`src-tauri/src/persistence.rs:250`).
- `activity.json`: lokalne dzienne liczniki obejrzanych/odrzuconych i suma; nie zawiera listy ID (`src-tauri/src/persistence.rs:391`).
- `favorites.json`: osobny JSON, niezależny od historii (`src-tauri/src/persistence.rs:173`).
- `localStorage`: motyw, akceptacja ostrzeżenia, rozmiar strony historii i miniatury. `sessionStorage` służy jeszcze do jednorazowej migracji dawnej historii (`src/client/app.ts:18`, `src/client/frame-cache.ts:8`).
- Pamięć procesu: bloby, cache rozwiązanych adresów (100 wpisów), `PendingFrame`, stan viewer oraz limiter. Obrazy nie są trwale cache’owane.

`clear_history` usuwa dziś **historię, cały rejestr eksploracji i activity**, pozostawiając favorites (`src-tauri/src/lib.rs:251`). Tego zachowania nie da się pogodzić z monotonicznym `seen` bez zmiany semantyki czyszczenia.

### 5. Recommended definition of `seen`

`(source, id)` staje się `seen`, gdy obraz **przeszedł dekodowanie i został zaakceptowany do wyświetlenia jako nowa pozycja historii**. W obecnym przepływie jest to `recordFrame()` po `decodedUrl()`; zapis `seen` należy związać z komendą `record_history_item`, którą `recordFrame()` wywołuje tuż przed `showFrame()`.

To operacyjna granica „pokazany”: nie można zagwarantować fizycznego odmalowania piksela, ale obraz jest już dekodowalny i zostaje natychmiast ustawiony na scenie. Nie oznaczać jako `seen` samego wygenerowania ID, pobrania bajtów, 404, odrzucenia parsera ani błędu sieci. Ponowne otwarcie przez historię/back/next/jump nie tworzy nowego wpisu `seen`. Jawne wejście po ID, także sąsiednim, może otworzyć ID już znane; zbiór pozostaje bez zmian.

W pierwszej wersji synchronizować wyłącznie legacy prnt.sc. Nowych formatów ID obecny walidator w ogóle nie obsługuje (`src-tauri/src/sources/prntsc/id.rs:43`).

### 6. Recommended sync architecture

W Rust dodać trwały monotoniczny `SeenStore` dla numerycznych legacy ID. Ma współpracować z istniejącym `ExplorationStore`, a nie zastępować go:

- `ExplorationStore` nadal rejestruje **lokalne wyniki prób** (`Viewed`, `Rejected`, `Unknown`) i zasila lokalne statystyki.
- `SeenStore` przechowuje **sumę ramek obejrzanych lokalnie lub na sparowanych urządzeniach**.
- Losowanie wyklucza ID obecne w którymkolwiek zbiorze. Zdalne `seen` nie powinno sztucznie zwiększać lokalnych dziennych liczników ani zmieniać klasyfikacji odrzuconych ID.
- Frontend widzi tylko operacje parowania i status. Sekret, szyfrowanie, HTTP, merge oraz pełny zbiór ID pozostają w Rust.

Osobny logiczny zbiór jest tu uzasadniony: dopisanie zdalnych ID jako lokalnych `Viewed` do istniejącego rejestru zafałszowałoby statystyki. Wykorzystane pozostaną istniejący katalog danych, konwersja base-36, wzorzec zapisu i punkt wykluczania w generatorze.

Przy okazji `pick_unexplored_id()` musi przestać zwracać ostatnie znane ID po 32 nieudanych losowaniach; dziś taki fallback łamie obietnicę braku powtórek (`src-tauri/src/sources/prntsc.rs:219`). Po limicie prób powinien zwrócić kontrolowany błąd. Warto też ponownie sprawdzić ID po fetchu, przed przekazaniem go do frontendu, jeśli w trakcie zakończył się sync.

### 7. Data model

Proponowany model Rust v1:

```text
SeenStore {
    legacy_prntsc: HashSet<u64>,
    path: PathBuf
}

SyncConfig {
    sync_id: public identifier,
    root_secret: OS credential store reference,
    last_known_revision: u64
}

SyncStatus {
    paired: bool,
    state: idle | syncing | offline | error,
    last_success: optional time,
    last_error: optional safe message
}

SyncSnapshotV1 {
    legacy_prntsc_seen: sorted unique u64 values
}
```

`u64` jest konieczne: górna granica `4_773_622_239` przekracza `u32`. Dla przyszłego źródła należy dodać osobną przestrzeń nazw i format ID; nie mieszać nowych stringowych ID prnt.sc z numerami legacy. Frontend potrzebuje tylko `SyncStatus` oraz wyniku `create/join/sync/leave`, bez kopii `HashSet`.

### 8. Storage format

| Wariant | Ocena dla tego repo |
|---|---|
| A. Pełny snapshot | Najprostszy protokół i merge. Posortowane `u64` w wersjonowanym formacie binarnym dają około 0,8 MB na 100 tys. ID i 8 MB na milion, przed narzutem szyfrowania. **Wybór dla v1.** |
| B. Lokalne `pending_since_sync` + snapshot | Przy pełnym pull i push nadal przesyła cały snapshot. Dodaje stan do odzyskiwania po awarii, nie rozwiązuje kosztu sieciowego. |
| C. Szyfrowane delty append-only | Oszczędzają transfer po wielu syncach, ale wymagają logu, numeracji, pobierania od kursora i kompaktowania. Na dziś zbyt duża zmiana. |
| Ranges / bitmap / RoaringTreemap | Losowe ID nie tworzą długich zakresów. Gęsta bitmapa całej przestrzeni to około 597 MB. RoaringTreemap warto zmierzyć dopiero przy dużym rzeczywistym zbiorze; nie ma go w zależnościach. |

Lokalny `SeenStore` może dopisywać pojedyncze numery podobnie do `prntsc-explored.txt`, a zdalny snapshot kodować jako posortowane 8-bajtowe liczby z wersją formatu. Import większej partii powinien zapisywać lokalny plik atomowo. Nie umieszczać zbioru w `localStorage`.

Próg do ponownej oceny: około **500 tys.–1 mln ID**, gdy pojedynczy snapshot ma 4–8 MB, a jeden sync przenosi pełny plik w obie strony. To próg pomiarowy, nie stwierdzona skala użytkowania. Repo nie ma danych o realnej liczbie ID; obecne `HistoryStore.record()` i tak przepisuje całą historię przy każdej nowej ramce, więc przy bardzo dużych wolumenach może stać się problemem wcześniej.

### 9. Sync protocol

- **Create:** Rust generuje sekret, wyprowadza identyfikator i klucze, zapisuje pairing lokalnie, tworzy na serwerze zaszyfrowany snapshot lokalnego `seen`. Pokazuje użytkownikowi recovery key. Niepowodzenie serwera pozostawia lokalną eksplorację dostępną i status oczekującego sync.
- **Join:** użytkownik podaje key; klient wyprowadza `sync_id`, pobiera blob, **odszyfrowuje i waliduje go przed zapisaniem pairing**, scala z lokalnym `seen`, zapisuje wynik i wysyła go z warunkiem revision. Błędny klucz nie może zmienić lokalnego stanu.
- **Startup:** po inicjalizacji lokalnego `AppState` uruchomić `syncNow()` asynchronicznie z `src/client/app.ts:27`, równolegle z obecnym przywracaniem historii. Pierwsza ramka nie czeka na sieć. Losowanie rozpoczęte przed zakończeniem sync może sporadycznie się powtórzyć — zgodnie z dopuszczonym UX.
- **Manual:** `Sync now` używa tej samej operacji. Jeden sync naraz na urządzeniu; przycisk pokazuje stan i ostatni wynik.
- **Merge:** lokalny snapshot ∪ odszyfrowany zdalny snapshot; zapis lokalny następuje przed push. Przy 409/412 pobrać nową revision, ponownie scalić i ponowić PUT.
- **Offline:** błędy transportu nie wpływają na zapis nowych lokalnych `seen` ani na losowanie. Kolejny startup lub ręczny sync ponawia próbę.
- **Nowe wpisy podczas sync:** lokalny zapis nie czeka na żądanie sieciowe. Sync pobiera aktualny snapshot pod krótką blokadą; wpisy dodane po jego pobraniu pozostają lokalne i trafią do następnego sync. Nie wolno zastąpić lokalnego zbioru starszym snapshotem z sieci.
- **Leave:** usuwa pairing/sekret, lecz nie usuwa lokalnego `seen`. Przy dołączeniu do innego chaina UI powinien jasno uprzedzić, że lokalny postęp zostanie z nim scalony.

Best-effort przy zamknięciu może później poprawić świeżość, ale nie jest potrzebny dla poprawności.

### 10. Cryptography and key handling

Wygenerować w Rust losowy 256-bitowy root secret z systemowego CSPRNG. Z niego przez HKDF z odrębnymi etykietami wyprowadzić klucz AEAD, token autoryzacyjny i publiczny `sync_id`. ID pochodne upraszcza recovery key: jeden sekret wystarcza do odnalezienia chaina i odszyfrowania danych; wynik HKDF przeznaczony na ID nie ujawnia root secret. Recovery key powinien kodować pełne 256 bitów, z wersją i kontrolą literówek. Nie proponuję własnego słownika mnemonic.

Szyfrować po stronie Rust sprawdzoną biblioteką AEAD, np. XChaCha20-Poly1305. Format blobu: wersja, losowy nonce, ciphertext i tag; `sync_id`, wersja formatu oraz revision jako authenticated associated data. Nie używać tu Argon2id, ponieważ użytkownik nie wybiera hasła — dostaje losowy sekret wysokiej entropii.

`Cargo.toml` ma `rand` i `reqwest`, ale nie ma bezpośredniej zależności HKDF, AEAD ani magazynu poświadczeń (`src-tauri/Cargo.toml:20`). Tranzytywne `chacha20` w lockfile nie stanowi gotowego API AEAD. Sekret nie powinien trafiać do `localStorage`, historii, logów ani serwera. Planowana integracja: systemowy magazyn poświadczeń przez bibliotekę Rust — Windows Credential Manager, macOS Keychain, Linux Secret Service tam, gdzie jest dostępny. Repo publikuje obecnie Linux i Windows (`README.md:26`); na Linux bez działającego magazynu bezpiecznym fallbackiem jest ponowne podanie recovery key, a nie cichy zapis plaintextu w pliku.

Serwer nadal widzi `sync_id`, rozmiar ciphertextu, revision, czas żądań i dane połączenia. Nie widzi ID ramek ani klucza szyfrowania.

### 11. Server API

Mały, osobno hostowany serwis HTTPS wystarczy. Jeden rekord: `sync_id`, weryfikator tokenu dostępu, revision, nieprzezroczyste bajty blobu.

| Operacja | Request | Response |
|---|---|---|
| Utworzenie | `PUT /sync/{id}`, `Authorization: Bearer <derived-token>`, `If-None-Match: *`, zaszyfrowany blob | `201`, `ETag: "1"`; istniejący rekord: `412` |
| Pobranie | `GET /sync/{id}`, ten sam Bearer | `200`, blob, `ETag: "<revision>"`; brak: `404` |
| Aktualizacja | `PUT /sync/{id}`, Bearer, `If-Match: "<revision>"`, nowy blob | `200/204`, kolejny ETag; niezgodność: `412 Precondition Failed` |

Serwer sprawdza uprawnienie, limit rozmiaru, limit żądań i warunek revision w jednej atomowej operacji. Nie parsuje snapshotu, nie scala zbiorów i nie otrzymuje root secret. Klient nigdy nie interpretuje `404` podczas zwykłego sync jako zgody na nadpisanie/utworzenie chaina.

### 12. UI changes

Jeden punkt wejścia „Sync” w istniejącym pasku narzędzi i mały dialog z: `Enable Sync`, `Join existing sync`, polem recovery key, `Sync now`, `Leave`, stanem/ostatnim udanym sync oraz komunikatem offline. Po utworzeniu pokazać key z możliwością skopiowania i jasną informacją, że utrata go uniemożliwia dołączenie kolejnego urządzenia.

Zmienić tekst przy `Hold to clear`: usuwa lokalną historię i dotychczasowe lokalne statystyki, lecz nie cofa postępu eksploracji. Zaktualizować `privacy.html`, `README.md` i zdania o danych lokalnych w interfejsie; obecne deklaracje byłyby nieprawdziwe po włączeniu sync. Sekret nie powinien być pokazywany przez ogólny `getSyncStatus()`.

### 13. Files to modify

**Existing files to modify**

| File | Po co |
|---|---|
| `src-tauri/src/persistence.rs` | `SeenStore`, migracja, atomowy merge i rozdzielenie `seen` od lokalnych klasyfikacji. |
| `src-tauri/src/sources/prntsc.rs` | Wykluczenie `seen`, przesunięcie oznaczenia `Viewed` po decode, poprawa limitu reroll. |
| `src-tauri/src/lib.rs` | Podłączenie store/sync, komendy create/join/now/leave/status, zmiana `clear_history` i zapis `seen` przy `record_history_item`. |
| `src-tauri/src/error.rs` | Bezpieczne typy błędów sync. |
| `src-tauri/Cargo.toml` i `Cargo.lock` | Bezpośrednie zależności crypto i secure storage. |
| `src/client/app.ts` | Automatyczny sync bez blokowania startupu. |
| `src/client/persistence.ts` | Cienkie typowane wywołania komend sync. |
| `src/client/elements.ts`, `index.html`, `src/styles/dialogs.css` | Kontrolki i dialog Sync. |
| `src/client/history-dialog.ts` | Komunikat po czyszczeniu zgodny z trwałym `seen`. |
| `privacy.html`, `README.md` | Opis opt-in sync i przesyłania zaszyfrowanego postępu. |

**Proposed new files**

| File | Po co |
|---|---|
| `src-tauri/src/sync.rs` | Pairing, szyfrowanie snapshotu, transport `reqwest`, CAS i status; bez kodu crypto w TypeScript. |
| `src/client/sync-dialog.ts` | Obsługa małego dialogu i komunikatów; frontend bez dostępu do zbioru `seen`. |
| `test/sync.test.mjs` | Integracja UI i komend w obecnym `node:test`, jeśli testy istniejącego `app.test.mjs` stałyby się zbyt rozległe. |

Serwis backendowy proponuję utrzymywać jako osobny projekt. W tym repo nie ma jego infrastruktury.

### 14. Migration strategy

Przy pierwszym uruchomieniu nowej wersji wypełnić `SeenStore` z ID prnt.sc obecnych w `history.json` oraz z lokalnych wpisów `,v` w `prntsc-explored.txt`; zignorować `,r` i niesklasyfikowane stare wiersze. Zapis oznaczenia migracji i wyniku musi być odporny na przerwanie, tak by ponowienie było idempotentne. Dawna migracja `sessionStorage` przechodzi już przez `record_history_item`, więc dołączy do nowego zapisu automatycznie.

Wpis `,v` bez historii jest niejednoznaczny: mógł pochodzić z pobranego, lecz niedekodowalnego obrazu. Importowanie go zachowuje dotychczasowe wykluczenie przez generator, kosztem możliwych pojedynczych false positives. Wcześniej wyczyszczonej historii i eksploracji nie da się odtworzyć.

Po migracji zapisywać `Viewed` dopiero na granicy `record_history_item`; `Rejected` nadal może powstawać podczas fetchu. Jeśli historia zapisze się, a zapis `seen` nie powiedzie, następny startup ponownie scala historię do `SeenStore`. Czyszczenie historii nie usuwa `SeenStore`.

### 15. Test plan

W istniejących testach Rust w `src-tauri/src/persistence.rs`: `A ∪ B`, zbiory identyczne, pusty local/remote, idempotentne ponowienie, trwałość po restarcie, batch import i przerwana migracja; osobno przypadki `history`, `,v`, `,r`, legacy unknown oraz `clear_history` zachowujące `seen`.

W `src-tauri/src/sources/prntsc.rs`: wylosowane `seen` jest pomijane, reroll wybiera nowe ID, wyczerpanie limitu kończy się błędem zamiast znanym ID, a sync zakończony podczas fetchu powoduje ponowne losowanie. Testy obecnego fallbacku z linii 442–455 trzeba zmienić.

W `src-tauri/src/lib.rs` i testach `node:test` w `test/app.test.mjs`: decode failure nie zapisuje `seen`; nowa ramka, adjacent navigation i ręczne ID zapisują go raz; back/next/jump/restore historii nie dodają nowego zdarzenia; brak serwera nie blokuje Draw, a późniejszy sync scala lokalne wpisy.

W nowym module Rust `sync.rs`: dwa urządzenia startują z revision 10, A zapisuje 11, B dostaje 412, pobiera 11, scala i zapisuje 12; test błędnego sekretu, zmodyfikowanego ciphertextu, poprawnego roundtrip AEAD, niepodmieniającego local merge oraz wpisu dodanego lokalnie podczas trwającego sync. Test serwisu osobno sprawdza atomowy CAS.

Istniejące bramki: `npm test`, `cargo test --locked`, `cargo clippy` i build Tauri w `.github/workflows/ci.yml:42`.

### 16. Risks / open questions

- Obecny `clear_history` usuwa eksplorację, a UI i dokumentacja mówią o czyszczeniu lokalnego postępu. Monotoniczny sync wymaga świadomej zmiany tej semantyki.
- Parser Rust akceptuje ID z zerami wiodącymi, bo sprowadza je do liczby; generator produkuje postać bez zer (`src-tauri/src/sources/prntsc/id.rs:32`). Przed migracją/sync należy ujednolicić lub odrzucać niekanoniczny zapis przy ręcznym wejściu, żeby dwie różne ścieżki URL nie zlały się przypadkowo w jedno ID.
- `prntsc-explored.txt` zawiera legacy `Unknown`, których znaczenia „obejrzany” nie da się ustalić. Nie synchronizować ich automatycznie.
- Statystyki pozostają lokalne; po sync liczba globalnych `seen` może przewyższać lokalne „Found”. UI powinien zachować to rozróżnienie.
- Linux jest platformą wydaniową, a repo nie ma secure storage. Zachowanie bez dostępnego systemowego magazynu sekretów trzeba przetestować na pakietach `.deb` i AppImage.
- Repo nie pokazuje rzeczywistych rozmiarów zbiorów użytkowników. Wybór przejścia z snapshotów na delty powinien wynikać z pomiaru rozmiaru i czasu sync, nie z samej wielkości przestrzeni ID.

### 17. Implementation sequence

1. Dodać lokalny monotoniczny `SeenStore` i idempotentną migrację obecnych danych.
2. Przenieść oznaczanie `Viewed` na zaakceptowany do wyświetlenia frame; zachować lokalne `Rejected` i dostosować activity.
3. Wpiąć `seen` do istniejącego losowania, poprawić 32-próbny fallback i sprawdzenie po fetchu.
4. Rozdzielić czyszczenie historii od trwałego `seen`; poprawić testy tej semantyki.
5. Dodać wersjonowany binarny snapshot i testy merge.
6. Dodać Rust crypto, recovery key i secure storage.
7. Przygotować oddzielny minimalny serwis z atomowym `If-Match`.
8. Dodać transport Rust, obsługę revision/412 i scenariusze offline.
9. Uruchomić automatyczny sync przy starcie oraz dodać dialog i `Sync now`.
10. Zaktualizować prywatność, dokumentację i przejść istniejące bramki CI.

### 18. Recommendation

V1: **lokalny `SeenStore` numerycznych legacy ID w Rust, pełny szyfrowany snapshot na prostym serwerze, merge przez sumę zbiorów i PUT warunkowy na revision**. Generator sprawdza ten zbiór razem z obecnym lokalnym `ExplorationStore`; frontend obsługuje tylko pairing i status. To najmniejszy model, który zachowuje znaczenie lokalnych statystyk, działa offline i unika requestu przy każdym losowaniu.
