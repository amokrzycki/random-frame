# Kolekcje zapisanych obrazów — plan wdrożenia

Data: 2026-10-12.

Status: uzgodniony plan do rozpoczęcia prac. Funkcja nie jest zaimplementowana.
Ten dokument konsoliduje plan z rozmowy oraz późniejsze poprawki; wcześniejsze,
rozdzielone wywołania tworzenia kolekcji i przypisywania w organizatorze zastępuje
jedna komenda zatwierdzająca cały formularz.

## 1. Cel i zakres pierwszej wersji

Użytkownik organizuje zachowane obrazy w samodzielnie tworzonych kolekcjach,
zachowując możliwość szybkiego zapisania wyświetlanego obrazu.

W zakresie:

- tworzenie, zmiana nazwy i usuwanie kolekcji;
- przypisanie jednego obrazu do jednej lub wielu kolekcji;
- przeniesienie między kolekcjami i usunięcie pojedynczego przypisania;
- przeglądanie wszystkich zapisanych, obrazów bez kolekcji i wybranej kolekcji;
- szybki zapis przez gwiazdkę i `F`;
- globalne usunięcie zapisów i zachowanie obecnego Undo;
- migracja istniejących ulubionych do zwykłej kolekcji „Ulubione”;
- synchronizacja zapisów, kolekcji, nazw, przypisań i usunięć;
- bezpieczne przejście ze starszych klientów na snapshot v3.

Poza zakresem: tagi, zagnieżdżanie, udostępnianie, automatyczna klasyfikacja,
przeciąganie, zaznaczanie grup obrazów, ręczne sortowanie i wybór nowych źródeł.
„Screenshots”, „Weird ones” i „NSFW” to zwykłe nazwy użytkownika.

## 2. Podstawa w aktualnym projekcie

### Aplikacja

- `src/client/favorites.ts`: `FavoriteItem`, `getFavorites`, `toggleFavorite`,
  `clearFavorites`; zapis obejmuje `source`, `id`, `sourcePageUrl`, `addedAt`.
- `src/client/frame-actions.ts`: `toggleCurrentFavorite` obsługuje gwiazdkę,
  `F`, lightbox i Undo z zachowaniem daty zapisu. `saveCurrent` oraz `S`
  eksportują plik i są osobną funkcją.
- `src/client/history-dialog.ts`: Favorites wykorzystuje siatkę historii,
  paginację, miniatury i istniejący mechanizm czyszczenia z Undo.
- `src/client/viewer-state.ts`: `applyFavorites`, `isFavorite`, `navigationView`
  i `refreshPersistedView`; osobny kontekst nawigacji oraz ochrona przed
  zastosowaniem spóźnionego odczytu po lokalnej zmianie.
- `src/client/frame-loader.ts`: zapisany obraz nieobecny w historii jest
  otwierany przez `loadById`; `goToPosition` korzysta z projekcji nawigacji.
- `src/client/frame-cache.ts`: ulubione chronią miniatury przed usuwaniem.
  Czyszczenie historii zachowuje te miniatury.
- `src-tauri/src/persistence/favorites.rs`: `FavoriteStore` zapisuje
  `favorites-v3.json`, migruje wcześniejsze dane, przechowuje operacje zapisania
  i tombstone’y usuniętych operacji. Kilka aktywnych zapisów tego samego
  `(source, id)` daje jeden obraz w UI.
- `src-tauri/src/persistence/io.rs` i `migration.rs`: atomowe zapisy, odzyskiwanie
  `.tmp`/`.bak`, wybór źródła migracji i potwierdzenia zakończonego importu.
- `src-tauri/src/persistence/transaction.rs`: wspólna blokada, dziennik,
  snapshot, merge/replace, generacje i trwałe zabezpieczenia wersji Sync.
- `src-tauri/src/snapshot.rs`: bieżący snapshot ma schemat 2, dekoder obsługuje
  również 1. `Register<T>` rozstrzyga konflikty przez `(clock, operation_id)`.
- `src-tauri/src/sync/`: GET, lokalne scalenie i PUT z retry po konflikcie CAS;
  istnieją odrębne tryby dołączania Restore i Merge.

Ulubione zachowują odnośniki i metadane, nie trwałe kopie pełnych obrazów.
Kolekcje zachowują ten model. Zniknięcie obrazu ze źródła pozostaje możliwe.

### Serwer

Przeanalizowany katalog: `/home/adrian/Repos/random-frame-server`.

- `src/main.rs`, funkcje `read` i `write`: przechowywanie nieprzezroczystych
  bajtów oraz atomowy `UPDATE ... WHERE revision = ?`.
- `migrations/001_initial.sql`: jeden zaszyfrowany payload BLOB na łańcuch Sync.
- GET zwraca dokładne bajty i ETag; nieaktualny PUT otrzymuje `412`.
- Serwer nie parsuje snapshotu, nie zna kolekcji i nie rozwiązuje konfliktów.
- Domyślny limit payloadu wynosi 64 MiB; konfiguracja może ustawić niższy.
- Istnieją testy nieprzezroczystości payloadu, limitów, CAS i restartu.

Kolekcje nie wymagają zmiany API ani schematu bazy serwera. Koperta
kryptograficzna, klucz odzyskiwania i protokół HTTP pozostają v1.
Wersjonowanie danych i ochrona przed cofnięciem schematu należą do aplikacji.

Wnioski dotyczą przeanalizowanego katalogu roboczego, który zawierał
niezacommitowane zmiany. Wersja, limity i konfiguracja działająca na VPS nie
zostały zweryfikowane.

## 3. Uzgodnione decyzje produktowe

1. **Obraz należy do zera, jednej lub wielu kolekcji.** Oddzielna biblioteka
   zapisów pozwala zachować obrazy po usunięciu ostatniego przypisania.
   Dodatkowy koszt wielu kolekcji to operacje przypisania, ich usunięcia
   i checkboxy; używamy istniejącego mechanizmu operacji zamiast nowej bazy
   lub ogólnej biblioteki CRDT.
2. **Szybki zapis trafia do wszystkich zapisanych, bez przypisania.** Nie
   zapamiętujemy ostatniej kolekcji jako domyślnego celu. „Bez kolekcji” jest
   filtrem, nie automatycznie tworzonym rekordem kolekcji.
3. **Gwiazdka i `F` zapisują nowy obraz, a dla zapisanego otwierają organizator.**
   Użytkownik zaakceptował zmianę dotychczasowego przełącznika dodaj/usuń.
4. **Usunięcie kolekcji zachowuje obrazy.** Pozostają we wszystkich zapisanych
   oraz w pozostałych kolekcjach; bez innych przypisań trafiają do filtra
   „Bez kolekcji”.
5. **Odpięcie i globalne usunięcie są osobnymi działaniami.** „Usuń z tej
   kolekcji” zmienia relację; „Usuń ze wszystkich zapisanych” usuwa globalny
   zapis i jego przypisania. Historia, pobrane pliki i źródło pozostają.
6. **„Ulubione” jest zwykłą kolekcją migracyjną.** Można ją przemianować lub
   usunąć. Nie odtwarzamy jej automatycznie.

## 4. Przepływ i zasady frontendu

Podstawa: `PRODUCT.md`, `DESIGN.md`, impeccable oraz UI UX Pro Max.
Kolekcje rozszerzają istniejące powierzchnie, przy zachowaniu głównego widoku
z jednym obrazem, obecnych fontów, tokenów, motywów i hierarchii działania Draw.
Nie dodajemy stałego panelu kolekcji do sceny ani drugiego głównego przycisku.

Etykiety w tym planie opisano po polsku. W implementacji zachowujemy obecny
angielski język UI; lokalizacja aplikacji nie jest częścią zadania.

### Szybki zapis i organizator

- Pusta gwiazdka lub `F` zapisują od razu, bez selektora. Toast potwierdza
  zapis i daje opcjonalny skrót „Kolekcje…”.
- Dla zapisanego obrazu gwiazdka lub `F` otwierają organizator.
- Gwiazdka pozostaje wyróżniona wizualnie, lecz nie ma `aria-pressed`, ponieważ
  przestaje być przełącznikiem. Dostępna nazwa informuje o zapisanym obrazie
  i otwarciu kolekcji; dla tego stanu używamy `aria-haspopup="dialog"`.
- Organizator zawiera checkboxy kolekcji, pole nowej nazwy, dodanie nowej
  kolekcji do roboczego formularza oraz Cancel/Apply.
- Nowa kolekcja jest robocza do Apply. Utworzenie i przypisanie są jedną
  operacją backendu. Cancel nie zostawia pustej kolekcji.
- Odznaczenie wszystkich checkboxów zachowuje zapis bez kolekcji.
- Błąd Apply zachowuje nazwy i wybory, pokazuje przyczynę przy formularzu
  i pozwala ponowić. Brak toastu sukcesu przed trwałym zapisem.
- Zmiany formularza wysyłamy jako dodania i usunięcia zaobserwowanych operacji,
  bez zastępowania całej listy przypisań.
- Globalne usuwanie jest tekstowo opisanym działaniem w organizatorze i menu
  obrazu. Jego odkrywalność wymaga próby z użytkownikiem.
- Zachowanie w lightboxie jest takie samo. Dialogi używają istniejących
  `openDialog`, `closeDialog`, inert i mechanizmu powrotu fokusu.

### Saved i zarządzanie kolekcjami

- Favorites w dialogu historii staje się Saved. Zakładki: History i Saved.
- Saved ma selektor wszystkich zapisanych, obrazów bez kolekcji i kolekcji
  użytkownika. Zachowuje istniejącą siatkę, paginację i pobieranie miniatur.
- Kolejność obrazów pozostaje według daty globalnego zapisu, od najnowszych;
  przypisanie do kolekcji nie zmienia tej daty.
- Dostępne są tworzenie pustej kolekcji, zmiana nazwy i usunięcie kolekcji.
  Potwierdzenie usunięcia podaje nazwę i wyjaśnia, że obrazy pozostaną zapisane;
  początkowy fokus jest na Cancel.
- Przeniesienie dodaje do celu i odpina ze źródła atomowo; pozostałe kolekcje
  są zachowane. Brak celu powoduje błąd całej operacji.
- Obecne Clear favorites zachowujemy jako globalne czyszczenie zapisów z Undo,
  wyłącznie w widoku wszystkich zapisanych. Kolekcje pozostają puste.
- Pusta biblioteka, pusta kolekcja i pusty filtr „Bez kolekcji” mają różne
  komunikaty. Błąd odczytu nie jest stanem pustym.

### Nawigacja, cache i dostępność

- Siatka, strzałki, skok do pozycji i lightbox korzystają z jednego filtra.
- Usunięcie aktywnej kolekcji przełącza filtr na wszystkie zapisane.
- Gdy pokazany obraz wypada z kolekcji, zachowujemy go na ekranie i przechodzimy
  do kontekstu wszystkich zapisanych, a po globalnym usunięciu do historii.
  Nie losujemy automatycznie kolejnego obrazu.
- Pinning miniatur obejmuje wszystkie globalnie zapisane obrazy, także bez
  kolekcji. Odpięcie, przeniesienie i usunięcie kolekcji nie zwalniają ochrony.
- Zachowujemy ochronę przed spóźnionym odczytem i serializujemy lokalne mutacje
  biblioteki. Odświeżenie po Sync nie odbiera fokusu i nie nadpisuje draftu.
- Usunięta zdalnie kolekcja jest niedostępna; błędne Apply nie usuwa innych
  wyborów. Zmiana nazwy nie zmienia tożsamości kolekcji.
- Rozróżniamy zachowanie obrazu w aplikacji od eksportu pliku przez Save image
  i `S`; tooltipy i komunikaty nie sugerują backupu pobranego pliku w Sync.
- Sprawdzamy Tab, Space, Enter, Esc, powrót fokusu, Android Back, czytnik ekranu,
  oba motywy, reduced motion, długie nazwy i obsługę bez hover.
- Desktop: sprawdzenie przy 800×600 oraz 1440×900. Android: mały ekran,
  orientacja pionowa i pozioma, widoczny fokus i pola ponad klawiaturą.

## 5. Model danych i walidacja

Pozostają istniejące `FavoriteRecord` i `favorites_removed` jako globalne
operacje zapisania obrazów oraz ich usunięcia. Można zachować wewnętrzne nazwy
`FavoriteItem`/`FavoriteStore`; masowa kosmetyczna zmiana nazw nie jest celem.

Nowe dane:

```text
CollectionRecord {
  collection_id: OperationId,
  name: Register<String>,
}

MembershipRecord {
  operation_id: OperationId,
  collection_id: OperationId,
  favorite_operation_id: OperationId,
}

collections_removed: OperationId[]
memberships_removed: OperationId[]
```

Cała biblioteka trafia do `favorites-v4.json`, pod jednym mutexem i istniejącą
generacją ulubionych. Poszczególne sekcje snapshotu są kanonicznie sortowane.
Rozszerzony `FavoriteSyncState` powinien mieć nazwane pola zamiast rozrastającej
się krotki. Nie dodajemy nowej bazy ani zależności.

Projekcja:

- jeden obraz na `(source, id)`, jak obecnie;
- kolekcja widoczna, jeśli jej ID nie jest usunięte;
- przypisanie aktywne przy aktywnym zapisie, aktywnej kolekcji i braku tombstone’a
  operacji przypisania;
- wiele aktywnych operacji relacji daje jeden checkbox i jeden kafelek;
- odwołania do nieobecnych lub usuniętych operacji są nieaktywne. Jest to ważne
  przy Restore; nie przywracamy zapisów tylko po to, aby domknąć relacje;
- ponowne zapisanie globalnie usuniętego obrazu tworzy nową operację zapisu
  i nie przywraca dawnych przypisań.

`SavedLibrary` jest jednym spójnym odczytem: zapisane obrazy wraz z ich aktywnymi
`saveOperationIds`, kolekcje i aktywne operacje przypisań potrzebne organizatorowi.
Nie utożsamiamy pozycji w siatce z ID operacji.

Nazwy są trimowane, niepuste, do 128 bajtów UTF-8, bez znaków sterujących.
Walidacja występuje w UI, IPC i dekoderze Sync. Dopuszczamy identyczne nazwy;
nie łączymy rekordów po nazwie. UI rozróżnia je pomocniczym numerem, bez zmiany
zapisanej nazwy. Identyfikatory pozostają losowymi 16-bajtowymi `OperationId`,
z wyjątkiem deterministycznych rekordów migracyjnych.

Zachowujemy dotychczasową walidację źródła, identyfikatora obrazu i pól metadanych
oraz limity bezpiecznego dekodowania. Lokalne wywołania wymagają prawidłowych,
istniejących celów; nie mogą dopisywać arbitralnych tombstone’ów nieznanych relacji.

## 6. IPC i atomowy kontrakt organizatora

Przed implementacją zamrażamy reprezentację `OperationId` na granicy IPC
jednolicie dla wszystkich nowych typów; Rust nadal używa `[u8; 16]`.
Poniższy kontrakt przedstawia pola, nie gotowy kod TypeScript.

```text
commit_collection_editor({
  requestId,
  frame: { source, id, expectedSaveOperationIds },
  createCollections: [{ collectionId, name }],
  addToCollectionIds: [collectionId],
  removeMembershipOperationIds: [operationId],
}) -> SavedLibrary
```

Nowe ID kolekcji powstają raz w roboczym formularzu, bez skutków trwałych.
Apply ustala żądanie i jego stabilne ID operacji. Ponowienie tego samego
żądania zachowuje payloady i nie tworzy dodatkowych kolekcji/przypisań.
Po zmianie formularza rozpoczynamy nowe żądanie. Początkowy rejestr utworzenia
kolekcji musi być stabilny przy retry; nie może nadpisać późniejszej zmiany nazwy.

Komenda:

1. Pod blokadą `PersistentState` i magazynu ulubionych sprawdza aktualny zestaw
   zapisów obrazu, wszystkie nazwy, ID, cele i wskazane operacje usunięcia.
2. Weryfikuje, że nowe ID nie przejmują istniejącej/usuniętej kolekcji.
   Idempotentne ponowienie tego samego utworzenia zachowuje jego tożsamość.
3. Przygotowuje na kopii danych tworzenie, dodania i odpięcia. Dodania odnoszą
   się do operacji z zatwierdzonego `expectedSaveOperationIds`.
4. Wykonuje jeden `save_json` obejmujący cały formularz.
5. Po powodzeniu podmienia stan w pamięci, zwiększa generację, jeśli dane się
   zmieniły, i zwraca spójną bibliotekę.

Nie wykonujemy dwóch kolejnych IPC `create_collection` i przypisania w tym
przepływie. Komenda jest również podstawą odpięcia i przeniesienia: usunięcie
dotyczy zaobserwowanych operacji ze źródła, dodanie dotyczy celu, inne relacje
pozostają.

Pozostałe komendy:

- `get_saved_library()`;
- `save_frame(item, collectionId?)`: idempotentny zapis; opcjonalny cel i zapis
  obrazu zatwierdzane razem. Nieprawidłowy cel powoduje błąd bez częściowego efektu;
- `create_collection(name)`: samodzielne tworzenie pustej kolekcji;
- `rename_collection(collectionId, name)` i `delete_collection(collectionId)`;
- `remove_saved_frame(source, id, expectedSaveOperationIds)`: globalne usunięcie
  ze zwrotem danych do Undo;
- `clear_saved_frames(...)`: zachowanie obecnego globalnego czyszczenia,
  obejmujące znane operacje, ze zwrotem danych do Undo;
- przywrócenie zapisów z danych Undo, obsługujące pojedynczy obraz i obecne Undo
  czyszczenia. Nie wskrzesza usuniętych kolekcji ani dawnych ID operacji.

Nowi callerzy nie używają `toggle_favorite` do zatwierdzania i przywracania.
Obecne API przełącznika nie powinno powodować usunięcia podczas retry.

## 7. Tożsamość zapisu podczas edycji

Przy otwarciu organizator zapamiętuje posortowany, niepusty zestaw aktywnych
`saveOperationIds` danego `(source, id)` jako `expectedSaveOperationIds` oraz
zaobserwowane operacje przypisań. Nie wystarcza para `(source, id)` ani
globalny numer generacji magazynu.

Apply wymaga dokładnej równości oczekiwanego i aktualnego zestawu. Sprawdzenie
oraz zapis następują pod tą samą blokadą. Zmiana innego obrazu ani nazwy
kolekcji nie unieważnia tego warunku.

Jeśli zapis usunięto albo powstały nowe operacje zapisania, komenda zwraca
`stale_saved_frame`, bez nowych kolekcji, przypisań i usunięć.

UI zachowuje draft, wyjaśnia zmianę zapisu i daje „Otwórz aktualny zapis”.
Użytkownik jawnie zaczyna nową edycję; dawnych wyborów nie przenosimy do niej
automatycznie. Jeśli obraz nie jest zapisany, pozostaje zamknięcie formularza.
Globalne usunięcie z organizatora lub otwartego potwierdzenia używa tego samego
warunku, aby nie usunąć nieświadomie nowego zapisu.

Reguła jest celowo konserwatywna: także dodatkowa, równoczesna operacja zapisu
tego samego obrazu wymaga ponownego otwarcia. Nie dodajemy osobnego mechanizmu
wersji/epok obrazu w pierwszej wersji.

## 8. Rozwiązywanie konfliktów

- **Nazwy:** istniejący `Register<String>`, z zegarem logicznym większym od
  zaobserwowanych zegarów nazw. Wygrywa większe `(clock, operation_id)`.
  Zmiana nazwy nie zależy od poprawności zegara ściennego urządzenia.
- **Dodania:** suma operacji; dodania do różnych kolekcji zachowują oba cele.
- **Odpięcie:** tombstone’y zaobserwowanych operacji przypisania. Nowe,
  niewidziane dodanie może przetrwać; po jego poznaniu ponowne odpięcie usuwa je.
- **Przeniesienie:** atomowe lokalne dodanie celu i odpięcie źródła. Konkurencyjne
  przeniesienia do różnych celów mogą pozostawić oba, zgodnie z modelem wielu
  kolekcji. Nie deklarujemy globalnej wyłączności przeniesienia.
- **Usunięcie kolekcji:** trwałe usunięcie jej ID wygrywa nad nazwą i przypisaniami.
  Kolekcja utworzona później pod tą samą nazwą ma inne ID.
- **Globalne usunięcie obrazu:** tombstone’y znanych operacji zapisania oraz
  zaobserwowanych przypisań. Późniejsza relacja do usuniętego zapisu jest
  nieaktywna. Niezależny niewidziany zapis offline może przetrwać.
- **Undo:** tworzy nowe operacje zapisu/przypisań, zachowuje datę globalnego
  zapisu i odtwarza relacje tylko do nadal istniejących kolekcji. Pozostawia
  tombstone’y i nie nadpisuje niezależnych relacji.
- **Sprzeczna treść tej samej operacji:** błąd danych, bez częściowego merge.
- **Tombstone’y:** zachowujemy wszystkie znane usunięcia. Nie dodajemy garbage
  collection. Przekroczenie budżetu uploadu daje błąd bez obcinania danych.

Merge musi być przemienny, łączny i idempotentny. Restore pozostaje odrębną
operacją, nie odmianą sumowania rekordów.

## 9. Pełna deterministyczna migracja

### Kanoniczne rekordy

`H128` oznacza pierwsze 16 bajtów SHA-256. Poniższe prefiksy są dokładnymi
ciągami UTF-8; do prefiksu przypisania dołączamy surowe 16 bajtów ID zapisu.
Wykorzystujemy już zainstalowany `sha2`.

```text
CollectionRecord {
  collection_id: H128("rf/collections/legacy-favorites/v1"),
  name: {
    clock: 0,
    operation_id: H128("rf/collections/legacy-favorites/name/v1"),
    value: "Ulubione",
  },
}

MembershipRecord {
  operation_id:
    H128("rf/collections/legacy-membership/v1" || favorite_operation_id),
  collection_id: H128("rf/collections/legacy-favorites/v1"),
  favorite_operation_id: istniejące ID operacji zapisu,
}
```

Migracja nie dodaje czasu wykonania, ID urządzenia ani lokalizowanej nazwy.
Dotyczy całego rekordu, w tym zegara i ID początkowego rejestru nazwy.
Nie zmienia ID zapisów, metadanych, `added_at` ani istniejących tombstone’ów.

Rename kolekcji migracyjnej ma zegar większy od zera; późniejszy początkowy
rejestr nie może go zastąpić. Tombstone kolekcji blokuje jej odtworzenie.
Deterministyczny tombstone relacji blokuje odtworzenie znanego przypisania
przez późniejszą migrację innego urządzenia.

Gwarancja relacji dotyczy tych samych operacji zapisu. Wcześniej nieznane zapisy
offline mają dotychczasową semantykę dodań. Dawne formaty bez ID wymagają
istniejącej migracji globalnych zapisów; nie utożsamiamy niezależnych operacji
tylko na podstawie `(source, id)`.

### Przebieg lokalny

1. Odczytać i zweryfikować `favorites-v3.json`, wraz z odzyskiwaniem plików
   tymczasowych; starsze formaty przeprowadzić istniejącą ścieżką importu.
2. Zachować globalne operacje i usunięcia bez zwijania do samej projekcji UI.
3. Dla aktywnych zapisów utworzyć kanoniczne rekordy migracyjne.
   Pusta biblioteka nie wymaga automatycznej pustej kolekcji.
4. Zapisać atomowo `favorites-v4.json`, następnie potwierdzenie migracji.
   Zachować poprzednie pliki jako źródło odzyskiwania.
5. Kolejne starty używają wyłącznie v4. Nie importują ponownie źródła po
   usunięciu kolekcji lub przypisania. Brak zatwierdzonego pliku docelowego
   nie może powodować cichego powrotu do starych danych.
6. Historyczny, oczekujący `state-transaction.json` wymaga konwersji efektów
   ulubionych tym samym deterministycznym mechanizmem podczas odzyskiwania.
   Operacje odzyskane po stworzeniu v4 również muszą otrzymać właściwe relacje.

Nowe pola snapshotu w lokalnych starych dziennikach muszą mieć obsługę braku
pól. Konwersję migracyjną stosujemy do historycznych zapisów, nie do każdego
pustego snapshotu lub nowego szybkiego zapisu.

## 10. Snapshot v3, Restore i zgodność

- Rozszerzyć `SyncSnapshot` o kolekcje, relacje i ich tombstone’y.
- Publikować schemat 3; czytać 1, 2 i 3.
- Zachować zamrożony kodek v1; wydzielić zamrożony kodek v2 do testów zgodności.
- Konwertować snapshoty 1/2 deterministycznie, tą samą funkcją co lokalne dane.
- Dodać sortowanie, walidację, bezpieczne liczniki i kontrolę budżetu bajtowego
  nowych sekcji, bez redukcji zawartości.
- Uzupełnić `has_meaningful_synchronized_state`, `SyncDomain`, podsumowanie
  dołączania i diagnostykę liczbową. Pusta kolekcja użytkownika jest znaczącym
  stanem. Diagnostyka nie ujawnia nazw, ID, URL-i ani zawartości.
- Zmienić `needs_upgrade` oraz wszystkie założenia i asercje wiążące upgrade
  wyłącznie ze schematem 1.

Nie dopisujemy danych na końcu schematu 2, ponieważ jego dekoder odrzuca
dodatkowe bajty. Nie publikujemy projekcji v2 usuwającej kolekcje dla starszych
klientów. Pełna równoczesna obsługa starych writerów wymagałaby większej zmiany
protokołu i nie jest częścią pierwszej wersji.

### Tryby dołączania

- Merge: suma zapisów, kolekcji, rejestrów, relacji i tombstone’ów.
- Restore z v3: reprezentowane domeny są zdalnie nadrzędne, także jawnie puste.
- Restore z v1/v2: zapisy obrazów pozostają zdalnie nadrzędne. Nieobsługiwane
  domeny kolekcji i relacji zachowujemy z jednego trwałego lokalnego snapshotu.
  Konwersja zdalnych ulubionych dodaje relacje migracyjne. Lokalne relacje do
  zapisów nieobecnych po Restore pozostają nieaktywne; nie importujemy przez nie
  lokalnych obrazów do Sync.
- Retry Restore, który napotka v3, zaczyna korzystać z zdalnie nadrzędnych
  kolekcji i relacji, zamiast zachowanych lokalnych domen.
- Zastąpienie lokalnego stanu następuje po akceptacji publikacji przez serwer,
  przez istniejący mechanizm dziennika i idempotentnego odtwarzania.

### Zabezpieczenia wersji

Aktualizujemy wszystkie wartości obecnie ograniczone do 1–2, m.in.
`highest_schema_version`, walidację konfiguracji, status i trwały schema floor.

`sync-publication.json` przechowuje rewizję bazową i rzeczywiście publikowany
schemat, zamiast niejawnie zakładać 2. Dawny wpis samej rewizji oznacza próbę
publikacji v2. Po niejednoznacznym wyniku PUT nowsza rewizja musi respektować
schemat tej próby; udowodniony konflikt CAS pozwala anulować jej znacznik.

Podnosimy floor po zweryfikowanym przyjęciu/publikacji v3; sama lokalna migracja
v4 nie blokuje pierwszego odczytu starego łańcucha. Floor i zgoda na upgrade to
odrębne informacje. Zgoda nigdy nie pozwala obejść odrzucenia downgrade’u.

Starszy klient może zapisać przed publikacją v3; nowy klient ma uwzględnić ten
zapis po retry CAS. Przygotowany stary PUT po v3 przegrywa CAS, a stary dekoder
odrzuca pobraną wersję przed kolejnym uploadem. Zapisy starego urządzenia
pozostają lokalne i mogą być scalone po aktualizacji.

## 11. Informacja i zgoda przed aktualizacją Sync

Aktualizacja aplikacji, migracja lokalna oraz automatyczny Sync nie mogą same
opublikować v3 do istniejącego łańcucha v1/v2.

Przed pierwszą publikacją do takiego łańcucha pokazujemy:

> Kolekcje wymagają nowszego formatu Sync. Zaktualizuj pozostałe urządzenia do
> wersji obsługującej kolekcje. Po zmianie starsze aplikacje przestaną się
> synchronizować; ich dane lokalne pozostaną.

Działania: „Później” i „Uaktualnij Sync”. Wyjaśnienie jest konsekwencją wydania,
a nie komunikatem wyświetlanym dopiero po błędzie na starszym urządzeniu.

- Backend sprawdza aktualny zdalny schemat przed modyfikacjami wynikającymi
  z dołączenia lub aktualizacji. GET/dekodowanie bez publikacji jest dozwolone.
- Zgoda jest trwała i przypisana do `(sync_id, schema = 3)` w lokalnych
  metadanych. Nie wolno utożsamiać jej z wykryciem nowszego schematu.
- Brak zgody wstrzymuje cały Sync i pozostawia wszystkie lokalne zmiany do
  publikacji. Lokalna biblioteka i kolekcje działają dalej.
- „Później” nie powoduje publikowania zastępczego snapshotu v2.
- Ręczny Sync, startup, powrót z tła, dołączanie Restore/Merge i retry używają
  jednej egzekwowanej w backendzie reguły. UI nie jest jedynym zabezpieczeniem.
- Dołączenie do łańcucha v1/v2 wymaga informacji i zatwierdzenia przed merge,
  zastąpieniem lokalnych danych i uploadem v3.
- Jeśli łańcuch jest już v3, kolejne urządzenie nie zatwierdza ponownie
  wykonanej aktualizacji.
- Tworzenie nowego Sync pokazuje wymaganie wersji innych klientów przed akcją;
  nie istnieje wtedy wcześniejszy łańcuch do uaktualnienia.
- Stan „Sync wymaga aktualizacji” nie jest sukcesem ani problemem sieciowym.
  Zachowujemy prawdziwą datę ostatniego sukcesu i oczekujące zmiany.

Lista znanych urządzeń nie zawiera wersji aplikacji ani potwierdzenia obecności.
Nie zapewniamy automatycznie, że wszystkie zostały zaktualizowane.

## 12. Mapa zmian

### Backend i trwały zapis

- `src-tauri/src/persistence/favorites.rs`: v4, rekordy, projekcje, walidacja,
  kanoniczna migracja, atomowe Apply, stale check, Undo, merge/replace, generacja.
- `src-tauri/src/persistence/mod.rs`: eksporty rozszerzonych typów.
- `src-tauri/src/persistence/migration.rs`: potwierdzenie nowej migracji;
  zachowanie obecnej obsługi odzyskiwania.
- `src-tauri/src/persistence/transaction.rs`: `snapshot_unlocked`, `apply`,
  `apply_replace`, stare dzienniki i mechanizmy publikacji/floor.
- `src-tauri/src/lib.rs`: nowe IPC, walidacja, rejestracja komend i zastąpienie
  callerów `get_favorites`/`toggle_favorite`/`clear_favorites`.

### Snapshot i Sync

- `src-tauri/src/snapshot.rs`: schemat 3, typy, kodek, walidacja, domeny,
  `needs_upgrade` i wykrywanie znaczącego stanu.
- `src-tauri/src/snapshot/merge.rs`: rejestry nazw, nowe operacje i tombstone’y.
- `src-tauri/src/snapshot/v2.rs` (nowy): zamrożony kodek schematu 2 do zgodności.
- `src-tauri/src/snapshot/diagnostics.rs`: liczniki nowych sekcji, bez danych.
- `src-tauri/src/sync/state.rs`: konfiguracja wersji, zgoda/stan upgrade,
  podsumowanie i status nowych domen.
- `src-tauri/src/sync/reconcile.rs`: dekodowanie, konwersja i domeny Restore.
- `src-tauri/src/sync/cas.rs`: retry, publication floor i kontrola aktualizacji.
- `src-tauri/src/sync/engine.rs`: create/join/sync/startup, zatwierdzenie,
  wersje statusu, poprawne dirty i akceptacja publikacji.
- `src-tauri/src/sync/errors.rs`: rozróżnienie wymaganego upgrade’u od awarii.
- `src-tauri/src/sync_crypto.rs`: walidacja v3 i testy; koperta pozostaje v1.
- `src-tauri/src/sync_transport.rs`: zachowanie aktualnego API i limitów;
  regresja kontraktu, bez nowego formatu HTTP.

### Frontend

- `src/client/favorites.ts`: `SavedLibrary`, odniesienia do zapisów i nowe IPC.
- `src/client/collections-dialog.ts` (nowy): właściciel draftu, formularz,
  walidacja, Apply/retry, stale state i powrót fokusu; reszta modułów go wywołuje.
- `src/client/frame-actions.ts`: szybki zapis, otwieranie organizatora, jawne
  globalne usuwanie i Undo; usunięcie użycia toggle do przywracania.
- `src/client/history-dialog.ts`: Saved, selektor, kolekcje, działania kafelków,
  przenoszenie, zakres czyszczenia i Undo.
- `src/client/viewer-state.ts`: pełna projekcja biblioteki, aktywny filtr,
  `navigationView`, serializacja mutacji i ochrona odświeżania.
- `src/client/app.ts`: inicjalizacja biblioteki przed pinningiem miniatur.
- `src/client/stage.ts`: etykiety, semantyka gwiazdki i kontekst pozycji.
- `src/client/frame-loader.ts`: otwieranie zapisów, komunikaty i nawigacja.
- `src/client/frame-cache.ts`: pinning wszystkich zapisanych.
- `src/client/shortcuts.ts`: `F`, ochrona aktywnego formularza i menu.
- `src/client/stats-dialog.ts`: znacznik zapisania, otwieranie obrazu.
- `src/client/elements.ts`, `dialogs.ts`: elementy i rejestracja dialogu,
  inert/fokus/zamykanie. Sprawdzić integrację z `android-navigation.ts`.
- `src/client/sync-api.ts`, `sync-dialog.ts`: zakres Sync, nowe liczniki,
  Restore/Merge oraz informacja i akcja przed publikacją v3.
- `index.html`, `src/styles/dialogs.css`, `viewer.css`, `responsive.css`:
  powierzchnie i stany w obecnym systemie, bez nowego frameworka.

### Dokumentacja i serwer

- `PRODUCT.md`, `DESIGN.md`: biblioteka, nowe znaczenie gwiazdki/`F`, zakres
  Sync, reguły interakcji i dostępności.
- `README.md`, `privacy.html`: opis zapisów, kolekcji, eksportu oraz zgodności.
- Fixtures i atrapy IPC opisane w sekcji testów muszą korzystać z nowej projekcji.
- Serwer: brak wymaganej zmiany kodu/migracji; sprawdzenie kontraktu przez
  integrację z uruchomionym serwerem, także jego skonfigurowanego limitu.

## 13. Kolejność wdrożenia i bramki

1. **Weryfikacja UX przed podłączeniem backendu.** Prototyp organizatora i Saved
   z rzeczywistymi przejściami w pamięci: pierwsza kolekcja, dwie kolekcje,
   odpięcie jednej, błąd Apply, nowy zapis podczas edycji, globalne usuwanie.
   Przeprowadzić próbę z użytkownikiem bez wskazywania przycisków. Poprawić
   problemy odkrywalności przed integracją.
2. **Model i migracja.** Zamrozić fixtures v2 i wektory rekordów migracyjnych.
   Dodać testy zasad, wdrożyć v4, atomowe mutacje i odzyskiwanie. Dowieść
   zachowania danych, ID, dat i tombstone’ów.
3. **Kontrakt Apply i IPC.** Wdrożyć jedną komendę formularza, dokładną
   weryfikację zapisu, stabilne retry i pozostałe operacje. Przetestować
   błędy bez częściowych efektów oraz przeplot z Sync.
4. **Snapshot i backend Sync.** Wdrożyć v3, konwersję, merge, Restore,
   zabezpieczenia publikacji oraz trwałe zatwierdzenie aktualizacji. Wszystkie
   ścieżki publikacji muszą być zabezpieczone przed ich użyciem przez frontend.
5. **Integracja UI i komunikatu upgrade’u.** Podłączyć sprawdzony przepływ,
   nawigację, Undo, cache i odświeżanie. Uaktualnić dokumenty produktu i designu.
6. **Regresja i wydanie.** Test z rzeczywistym serwerem, desktop i Android,
   awarie/restarty, dokumentacja i komunikat o wymaganej aktualizacji innych
   urządzeń przed pierwszym PUT v3.

Etapy to zależności implementacyjne, nie osobne niekompletne wydania dla
użytkowników. Wersja publikująca v3 musi mieć pełną obsługę nowych domen,
odzyskiwania, informacji przed upgrade’em i nowych przepływów UI.

### Próba użytkowa prototypu

Bez instrukcji wskazujących kontrolki poprosić o:

1. Stworzenie pierwszej kolekcji.
2. Przypisanie obrazu do dwóch kolekcji.
3. Usunięcie obrazu z jednej, przy zachowaniu drugiej i globalnego zapisu.
4. Ponowienie Apply po zasymulowanym błędzie.
5. Znalezienie globalnego usuwania i wyjaśnienie jego skutku.

Bramka: zadania są wykonalne bez podpowiadania przycisków; użytkownik odróżnia
odpięcie, usunięcie kolekcji i globalne usunięcie; błąd nie powoduje utraty
wyborów. Sprawdzić też klawiaturę, długie nazwy i małe okno.
Przegląd przez autora ani użycie skills nie zastępują tej próby.

## 14. Testy implementacji

### Magazyn, atomowość i Undo

W `src-tauri/src/persistence/tests/history_favorites.rs` i osobnym pliku testów
kolekcji, jeśli potrzebny dla czytelności:

- zero/jedna/wiele kolekcji, deduplikacja projekcji i zachowanie dat;
- odpięcie jednej i ostatniej relacji bez globalnego usunięcia;
- usunięcie kolekcji zachowuje obrazy i pozostałe przypisania;
- utworzenie dwóch kolekcji i relacji przez jeden commit;
- błędny ostatni element formularza, brak celu i błąd zapisu nie zostawiają
  żadnych częściowych efektów;
- retry tego samego żądania nie duplikuje rekordów ani nie odtwarza relacji
  usuniętej po jego zaakceptowaniu;
- atomowe przeniesienie i jego błąd;
- globalne usunięcie, ponowny zapis bez dawnych przypisań, Undo oraz globalne
  czyszczenie z zachowaniem pustych kolekcji;
- Undo pomija usunięte kolekcje, zachowuje niezależne relacje i jest ponawialne.

### Organizator i wyścigi

- Otworzyć dla operacji A, usunąć A przez Sync, zapisać B z tym samym kluczem,
  wykonać stary Apply. Oczekiwany `stale_saved_frame`; B, jego przypisania
  i kolekcje pozostają bez zmian.
- Analogicznie obraz usunięty bez ponownego zapisu.
- Zmiana innego obrazu nie powoduje stale; dodatkowa operacja tego samego
  obrazu powoduje stale zgodnie z przyjętą regułą.
- Test przeplotu pomiędzy sprawdzeniem tożsamości a zapisem dowodzi wspólnej
  blokady; nowa operacja nie może pojawić się w tej luce.
- Stare potwierdzenie globalnego usunięcia nie usuwa nowego zapisu.
- Odpięcie z formularza nie usuwa nowej, niewidzianej relacji z Sync.

### Migracja i odzyskiwanie

W `persistence/tests/migration.rs`, `backup_recovery.rs`, `restore.rs`
i fixtures:

- wszystkie stare formaty, identyczne ID/datowane metadane/tombstone’y;
- zgodne pełne rekordy A/B, z zamrożonymi wektorami haszy i rejestru nazwy;
- A migruje i przemianowuje, B migruje później: nazwa nie cofa się;
- A usuwa kolekcję, B migruje później: kolekcja nie wraca;
- A usuwa przypisanie, B migruje później: znana relacja nie wraca;
- różne kolejności merge, ponowne importy, restart i receipt;
- awaria przed/podczas zapisu i po pliku v4 przed receipt;
- brak zatwierdzonego pliku docelowego nie uruchamia ponownego importu;
- pending stary dziennik, w tym Restore, nie pomija migrowanych zapisów.

### Snapshot, konflikty i Sync

W `snapshot/tests.rs`, `sync/tests.rs`, `join_mode_tests.rs`,
`config_recovery_tests.rs` i `large_upgrade_tests.rs`:

- round-trip v3 oraz zamrożone snapshoty 1/2;
- kolejność/duplikaty, nieprawidłowe nazwy i pola, konflikt payloadu operacji,
  uszkodzenie/przepełnienie i budżet bajtowy;
- przemienność, łączność, idempotencja i zbieżność dwóch/trzech urządzeń;
- równoczesne nazwy, dodanie/odpięcie, przeniesienia i delete kolekcji;
- niewidziane zapisy offline kontra globalne usunięcie;
- Restore/Merge dla 1–3, jawnie puste domeny, nieaktywne relacje i zmiana
  schematu podczas retry;
- stary writer przed migracją jest uwzględniony; po v3 nie nadpisuje danych;
- v2 po przyjętym v3 jest odrzucany także po restarcie;
- niejednoznaczny sukces PUT i stary wpis publication journal;
- bez zgody brak PUT v3 z ręcznego/startup/resume/join/retry;
- zgoda przetrwa restart, dotyczy właściwego Sync i nie omija schema floor;
- oczekujący upgrade nie oznacza sukcesu, nie traci dirty i nie publikuje v2.

Jeden test kontraktu klienta z rzeczywistym serwerem sprawdza zaszyfrowany
snapshot v3, dokładność odczytanych bajtów, wyścig v2/v3 oraz CAS. Sprawdzić
również niższy skonfigurowany limit bez utraty lokalnych danych.

### Frontend i platformy

Zaktualizować `test/favorites.test.mjs`, `persisted-view.test.mjs`,
`thumbnail-pinning.test.mjs`, `sync.test.mjs`, `dom-fakes.mjs` i pozostałe
fixtures i wywołania korzystające z `get_favorites`/`toggle_favorite`.
Objąć testami startup, recovery, historię, lightbox, focus, dialogs,
Android navigation i thumbnail file cache w odpowiednich istniejących plikach.

Sprawdzić: pojedynczy szybki zapis, brak destrukcyjnego drugiego `F`, Cancel
bez danych trwałych, wielokrotne kliknięcie Apply, zachowany draft po błędzie,
stale recovery, wspólny filtr nawigacji, brak utraty miniatur i spóźniony refresh.
Osobno sprawdzić informację i akcję przed zmianą Sync.

### Polecenia weryfikacji po implementacji

```sh
npm test
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --workspace --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace --all-features
```

Zachować istniejące CI Linux/Windows, build Tauri oraz Android build/smoke.
Ręczne sprawdzenie obejmuje klawiaturę, czytnik ekranu, dotyk i dwa motywy.

## 15. Kryteria akceptacji

- [ ] Próba użytkowa spełnia bramkę przed pełnym podłączeniem backendu.
- [ ] Istniejące ulubione są w „Ulubionych”, bez utraty danych/dat/ID/usunięć.
- [ ] Kolekcje można tworzyć, przemianowywać i usuwać.
- [ ] Obraz może mieć zero, jedno lub wiele aktywnych przypisań.
- [ ] Szybki zapis to jedna aktywacja; następna otwiera organizator.
- [ ] Cały formularz, wraz z nowymi kolekcjami, zatwierdza jedno IPC i jeden zapis.
- [ ] Cancel i błąd Apply nie tworzą częściowych danych; błąd zachowuje wybory.
- [ ] Stary formularz i stare potwierdzenie nie działają na nowym zapisie obrazu.
- [ ] Odpięcie oraz usunięcie kolekcji zachowują obraz globalnie.
- [ ] Przeniesienie jest lokalnie atomowe i zachowuje inne przypisania.
- [ ] Globalne usuwanie jest odkrywalne i jednoznaczne; Undo odtwarza właściwe
  zapisy i relacje do nadal istniejących kolekcji.
- [ ] Siatka, paginacja, strzałki, skok i lightbox mają jeden kontekst filtra.
- [ ] Wszystkie zapisane miniatury są chronione, także bez kolekcji.
- [ ] Restart/awaria nie zostawiają częściowej migracji ani przeniesienia.
- [ ] Późna migracja nie cofa nazwy ani znanych usunięć kolekcji i relacji.
- [ ] Nowe klienty osiągają wspólny stan po konfliktach i ponownym Sync.
- [ ] Informacja oraz zatwierdzenie poprzedzają pierwszą publikację v3 do starego
  łańcucha, także w ścieżkach automatycznych.
- [ ] Starszy klient nie nadpisuje v3, zachowuje dane lokalne i wymaga aktualizacji.
- [ ] Restore/Merge respektują możliwości schematu i znaczenie pustych domen.
- [ ] Nie ma klasyfikacji treści wynikającej z nazwy kolekcji.
- [ ] Sprawdzenia projektu, platform i kontraktu serwera przechodzą.

## 16. Ryzyka, odzyskiwanie i ograniczenia dowodów

- Największe ryzyko utraty danych: pominięty caller, częściowy commit,
  niezabezpieczony publisher, niepełny dziennik i ponowny import legacy.
  Odpowiadają im wskazane testy regresji i awarii.
- Po publikacji v3 starsze klienty przestają synchronizować. Komunikat przed
  publikacją jest obowiązkowy; dotyczy także wolniej aktualizowanych APK.
- Nieznane dodania offline mogą przetrwać odpięcie/globalne usunięcie.
  Nie obiecujemy globalnej dominacji delete dla logicznego `(source, id)`.
- Zachowane odnośniki i miniatury nie gwarantują dostępności oryginału ze źródła.
- Rosnące relacje i tombstone’y zwiększają snapshot. Błąd limitu nie usuwa danych.
- Rollback po v3 wymaga wersji naprawczej obsługującej v3. Nie cofamy schematu
  aktywnego łańcucha ani nie usuwamy znaczników zabezpieczeń.
- Przed wdrożeniem zachować kopię profilu; stare pliki migracyjne pozostają.
  Powrót starej aplikacji może służyć odzyskowi kopii w odłączonym profilu,
  ale nie reprezentuje nowych kolekcji i zmian v4.
- Backup serwera jest niezależny od rollbacku aplikacji. Przy SQLite WAL
  korzystać z istniejącego `deploy/backup.py`/SQLite backup API, nie kopii
  aktywnego pliku bazy. Nie przywracać globalnej bazy jako zwykłego sposobu
  cofnięcia migracji jednego użytkownika.

W rozmowie przygotowano interaktywny prototyp działający wyłącznie w pamięci.
Przegląd obejmował szerokości 728/360 px, stan błędu i stale oraz 10 kontroli
zachowania. Prototyp nie jest częścią kodu aplikacji ani dowodem poprawności
Rust/IPC/Sync. Nie przeprowadzono próby z użytkownikiem, testów funkcji na
rzeczywistym backendzie ani kontroli wdrożenia VPS. Są to etapy do wykonania,
nie zaliczone kryteria akceptacji.
