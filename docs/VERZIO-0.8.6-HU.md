# 0.8.6 – Filmfigyelő, foglaltságjelzés, helyreállítás és HDD-takarítás

## 1. Foglaltságjelzés

A film forráslistájának első sora jelzi, hogy a szerver szabad-e. A szabály továbbra is **egy kizárólagos 4K film, vagy legfeljebb két HD film különböző IP-címről; egy IP-hez egy film**. A saját film folytatható, a saját IP új HD-filmje a korábbi filmet lecserélheti. Sikertelen 4K-váltás nem állítja le a korábbi HD-filmet.

Foglalt források neve `nCore · FOGLALT`; leírásuk megmondja az okot: másik készülék 4K-ja, HD mellett nem indítható 4K, vagy mindkét HD hely foglalt. A forráslista lekérése nem foglal helyet. A Go motor indításkor továbbra is atomikusan ellenőriz, tehát az időközben elavult lista sem kerülheti meg a korlátot. Kapacitáshibánál HTTP 429 és 60 másodperces újrapróbálkozási tájékoztató marad; automatikus várólista nincs. A TV saját általános hibaablakának szövegét nem ez a kiegészítő vezérli.

## 2. Telefonos állapotoldal

Útvonal: a már működő addon webcímén **`/control/`**. A meglévő **SNA rendszergazdai fiók** szükséges, nem a Stremio-felhő és nem az operációs rendszer fiókja. Nincs új hálózatra nyitott kezelőport: a háttérszolgáltatást a Node egy root tulajdonú Unix socketen éri el.

Megjelenik a kapacitás, a foglalt IP-k és filmek, a kapcsolat/türelmi idő, a betöltött torrentek készültsége, pillanatnyi le-/feltöltési sebessége és aránya, a HDD szabad helye, a hibák és helyreállítási események. A sebesség két mintavétel közötti számlálókülönbségből számolódik, az első minta ezért nullás lehet. Az oldal 10 másodpercenként frissít, a háttér alapból 15 másodpercenként mér. A 45 másodpercnél régebbi állapot külön jelzést kap.

Az iPhone-on Safari megosztási menüjéből a főképernyőre tehető. Van alkalmazásmanifest, ikon és önálló nézet. Nincs App Store-os natív csomag, offline filmkiszolgálás vagy háttérben futó iPhone-figyelés; a szervernek és a HDD-nek működnie kell. A telepítés továbbra is LAN-ra korlátozott, mobilinternetről nincs hozzáférés. Távoli használathoz külön, hitelesített VPN-hozzáférés alakítható ki; porttovábbítás nem lett beállítva.

## 3. Automatikus hibafelismerés és helyreállítás

- Tényleges LAN-manifest, torrentlista és limiter API ellenőrzése.
- Három egymást követő állapothiba után konténer-újraindítás; induláskor 120 másodperces türelmi idő.
- Legalább 10 perc két újraindítási kísérlet között, legfeljebb 3 kísérlet óránként. A próbálkozások a HDD-n megmaradnak.
- A következő sikeres API-mérés igazolja a működést. A sikeres restart parancs önmagában nem minősül helyreállítási bizonyítéknak.
- A kézzel leállított konténert nem indítja el. HDD-hiány, rossz UUID, csak olvasható HDD vagy friss lemez-I/O hiba esetén nem próbál újraindítással javítani.
- A TV nyugtázásának elakadása külön hálózati figyelmeztetés. A két perce változatlan letöltés önmagában csak tájékoztató: lehet puffer, szüneteltetés vagy lassú forrás. Ezekre nincs szerver-restart.

Egy szükséges helyreállítás megszakíthatja a lejátszást; a TV-n szükség lehet újbóli indításra. A szolgáltatás nem tud hibás routert, Wi-Fi-hálózatot vagy fizikai HDD-kábelt automatikusan megjavítani.

## 4. HDD-takarítás

Automatikusan **200 GiB alatti szabad helynél**, legfeljebb **300 GiB szabad helyig** takarít. Csak teljesen letöltött, legalább 1-es visszaosztási arányú, legalább 30 napja ismert és nem használt film lehet jelölt. A számlálás a funkció telepítésekor indul; korábbi nézési időt nem találunk ki.

A **„Megőrzöm”** kapcsoló kizárja a filmet a takarításból. Aktív/türelmi idővel foglalt, részben letöltött, közös adatkönyvtárú vagy bizonytalan descriptorú torrent nem törlődik. A Go motor a törlést a lejátszás indításával közös zárolás mellett kezeli, így egy frissen indult film sem törölhető a korábbi előnézet alapján. A törlési cél kizárólag a beállított letöltési gyökér egy saját alkönyvtára/fájlja lehet; útvonalkitörés és symlink cél tiltott.

Kézzel az állapotoldalon először a jelöltek listája kérhető le. A két percig érvényes listát megerősítve a háttér egyenként, újbóli ellenőrzéssel takarít. Nem töröl másik, időközben újonnan jogosult filmet a jóváhagyott lista helyett. Az eredmény az eseményeknél követhető.

A még be nem töltött régi torrentek és a nem eléggé visszaosztott tartalmak megmaradnak. A régi `deleteAfterHitnrun` időzítőt a kezelt telepítésben az új, megőrzési jelölést ismerő szolgáltatás váltja fel. A lemezhelymérés a HDD-re mutató `DOWNLOADS_DIR` kötetét méri; korábban az SSD-s állapotkönyvtárat mérte.

## Ellenőrzési bizonyíték és határok

- Teljes Docker-build: Go tesztek, TypeScript-fordítás, kliensbuild, kérésmegszakítási és foglaltságjelzési tesztek.
- **55 elkülönített integrációs ellenőrzés:** tényleges Node/Go HTTP-kérések, HD/4K/IP kombinációk, hamis IP-fejlécek, tíz kliensmegszakítás, aktív torrent törlésének visszautasítása, feltöltetlen tartalom takarításának tiltása, saját próbafájl törlése és mellette védett fájl megőrzése, admin/CSRF-ellenőrzés, statikus felület és Unix socket.
- A tesztkonténer Go motorját ténylegesen leállítottuk. A figyelő kivárta a három hibát, újraindította a tesztkonténert, majd sikeresen újraellenőrizte az API-kat. Az éles rendszerben nem idéztünk elő ilyen hibát.
- **18 Python vezérlési teszt:** szimulált idő és állapot, újraindítási korlátok, HDD-hibák, védett/törölhető jelöltek, lejárt lista, megőrzés friss ellenőrzése, descriptorvédelem, célhely elérésekor leálló takarítás, sérült vagy nem menthető állapot védelme.
- Elkülönített DOM-teszt: kapacitás, lejátszások, biztonságos szövegmegjelenítés, megőrzési kapcsoló, belépés megkövetelése, űrlap és jelszómező ürítése.
- Az éles utóellenőrzés nem kér le videót és nem töröl filmet: az API-kat, jogosultságot, visszaállított megőrzési próbát és a Toy Story forrásleírásait vizsgálja. Az átmeneti helyi tesztmunkamenet azonnal visszavonódik.

A DOM-teszt nem fizikai iPhone/Safari vagy TV-felületpróba. A környezetben nem volt elérhető vezérelhető böngészőfelület; a valódi iPhone-kezdőképernyős használatot a készüléken kell kipróbálni. A mesterséges tesztfájlok ellenőrzése nem többórás TV-s filmnézési próba.

Az aktív letöltések és az új szolgáltatás saját állapota/naplója a HDD-n marad; SSD-puffer nem készült. A korábbi Docker-/rendszernaplók és adatbázis helye nem változott. A részletes telepítési és konfigurációs minta a [vezérlőszolgáltatás leírásában](../deployment/control/README-HU.md) található.
