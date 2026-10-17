# Filmfigyelő vezérlőszolgáltatás

A mobilos felület a normál addon `/control/` útvonalán érhető el, HTTP-n és a már beállított HTTPS-en is. Új nyilvános TCP-port nem kell hozzá. A `/api/control/*` végpontok a meglévő SNA rendszergazdai munkamenetet igénylik; a módosítások azonos eredetű JSON-kérések lehetnek. A háttérszolgáltatás kizárólag root tulajdonú Unix socketen hallgat.

## Telepítés másik gépre

1. Építsd fel a 0.8.6 forrását és futtasd a teszteket. A Dockerfile tartalmazza a Go és a foglaltságjelzési teszteket.
2. Másold a `control.py` fájlt `/usr/local/lib/stremio-control/control.py` alá root tulajdonnal, 0644 jogosultsággal. Külső Python-csomag nem szükséges.
3. A `config.example.json` alapján készíts root tulajdonú, 0600 jogosultságú `/etc/stremio-control.json` fájlt a valós HDD-csatolási ponttal, UUID-val, torrentleíró-könyvtárral és a tényleges, LAN-on közzétett webcímmel. A HDD alatt hozd létre a `stremio-ncore/control` könyvtárat.
4. A systemd mintában cseréld a `@...@` helyőrzőket. A csatolási egység nevét `systemd-escape --path --suffix=mount <csatolási pont>` adja meg. A `ReadWritePaths` könyvtáraknak létezniük kell.
5. A `compose.control.yaml` felülírást illeszd a tényleges Compose-szolgáltatásnévhez. A gazdagépen előbb létezzen a `/run/stremio-control` könyvtár, utána hozd létre a konténert. A socket könyvtára újraindításkor megmarad; a program ugyanebben a könyvtárban újítja meg a socketet.
6. Ellenőrizd a unitot `systemd-analyze verify` paranccsal, majd engedélyezd a szolgáltatást. Docker systemd drop-inben `Wants=stremio-control.service` biztosíthatja az együttindulást. A HDD csatolási követelményeit a Dockerhez is külön meg kell tartani.
7. Üres kiszolgálón telepíts, mentett Compose-konfigurációval és adatbázissal. Ellenőrizd a LAN-manifestet, a torrentmotort, a `/control/` oldalt és a jogosultságokat. A puszta `running` konténerállapot nem elég.

## Takarítási szabály

Automatikus takarítás 200 GiB alatti szabad hely esetén, legfeljebb 300 GiB szabad helyig. Egyszerre csak egy filmet töröl, ciklusonként legfeljebb 20 jelöltből. A jelöltek teljesek, legalább 1-es arányúak, legalább 30 napja ismertek és nem használtak. Aktív/türelmi idővel fenntartott, megőrzött, részleges vagy közös adatkönyvtárú torrent nem törölhető. Sérült vagy bizonytalan torrentleíró esetén a kiválasztás leáll.

A kézi takarítás először két percig érvényes listát ad; a felhasználó megerősítése után a háttérben végrehajtja, minden tételnél frissen ellenőrizve a feltételeket. A Go motor a lejátszási foglalással közös zárolás mellett védi az aktív adatokat. A letöltési gyökéren kívüli és symlink célok tiltottak. A descriptor csak sikeres adateltávolítás után törlődik.

Az életkor első telepítéskor indul, nem találjuk ki a korábbi nézési dátumot. A jelenleg be nem töltött régi torrenteket nem törli automatikusan. A visszaosztási arány ellenőrzése konzervatív: a Go motor jelenlegi munkamenetének tényleges számlálóját is teljesíteni kell. Az új szolgáltatás a régi `deleteAfterHitnrun` időzítőt az env kapcsolóval kiváltja, hogy ne kerülhesse meg a megőrzési jelölést.

## Helyreállítás és naplózás

15 másodpercenként ellenőrzi a tényleges LAN-manifestet és a belső torrent/limiter API-t. Három egymást követő hiba után konténer-újraindítás történhet, az első 120 másodpercben türelmi idővel; legalább 10 perc két kísérlet között, legfeljebb 3 óránként. Aktív lejátszás nem halaszthatja korlátlanul a hibás motor helyreállítását. A következő API-próba igazolja a javulást; a sikeres restart parancs önmagában nem.

A szándékosan leállított konténert nem indítja el. Hiányzó, rossz UUID-jú vagy csak olvasható HDD esetén nem ír, nem takarít és nem indít újra. Friss lemez-I/O hiba szintén tiltja a helyreállítást/takarítást. A TV nyugtázásának elakadása és a hiányzó új torrentadat külön figyelmeztetés; nem vált ki szerver-újraindítást.

A megőrzési állapot, az életkorok és az újraindítási korlát a HDD `stremio-ncore/control/state.json` fájljában van; az események két, egyenként kb. 2 MiB-os JSONL fájlban. Állapotmentés legfeljebb félóránként, illetve lényeges változáskor történik. A korábbi passzív monitor tovább működik. Nem került SSD-re letöltési puffer.

## Ellenőrzések

`python3 -m unittest -v test_control.py`: szimulált idő/állapot, helyreállítási korlátok, védett és törölhető jelöltek, descriptor és külső fájl védelme. `test_ui.mjs`: elkülönített jsdom felületteszt (nem fizikai iPhone/Safari próba). A gazdagép integrációs telepítőtesztje valós, kizárólag próbafájlokat tartalmazó Node/Go konténeren ellenőrzi a lejátszási limiteket, megszakításokat, védett törlést, admin/CSRF-ellenőrzést és tényleges motorleállítás utáni automatikus API-helyreállítást.

Az integrációs futtató a `test_integration.py`. Rootként, Dockerrel fut; alapértelmezett munkakönyvtára `/opt/stremio-ncore`, ez `STREMIO_TEST_SETUP` változóval módosítható. Meglévő tesztimage esetén: `STREMIO_TEST_SOURCE=/a/forras/abszolut/utja python3 test_integration.py --version=0.8.6 --test-only`. Az image neve ekkor `stremio-ncore-addon:control-0.8.6`. Szükséges egy, a munkakönyvtár `data/config/sna.db` útján lévő érvényes adatbázissablon rendszergazdai rekorddal. Ezt csak lemásolja, majd a másolatban készít rövid életű, kizárólag a tesztkonténerben érvényes munkamenetet és kiegészítőtokent. A tesztkonténer külön nevet és kizárólag loopbackre kötött portokat használ; névütközés esetén megáll. A tesztfixture privát könyvtárban megmarad ellenőrzéshez, és valódi fiókok hash-elt adatait is tartalmazhatja az adatbázissablonból: ne publikáld. A tesztek nem kérnek le éles videót, a valódi konténert nem indítják újra és nem törlik.
