# nCore 0.8.4 – eszközönkénti és közös lejátszási korlát

A 0.8.4 megtartja a [0.8.3 katalógus-, keresési, tárolási és seedelési funkcióit](VERZIO-0.8.3-HU.md), és lecseréli az egyetlen aktív torrentet kezelő, 4 órás korlátozót.

## Engedélyezett kombinációk

| Már fut | Új kérés | Eredmény |
| --- | --- | --- |
| Semmi | 1 darab 4K | Engedélyezett |
| 1 darab 4K | Másik IP-ről bármilyen film | Elutasítva, a futó film megmarad |
| Semmi | 1 darab 1080p | Engedélyezett |
| 1 darab 1080p | Másik IP-ről 1 darab 1080p | Engedélyezett |
| 2 darab 1080p | Harmadik IP-ről új film | Elutasítva, a két futó film megmarad |
| 1 vagy 2 darab 1080p | Másik IP-ről 4K | Elutasítva |

Egy helyi IP-címhez egyszerre egy torrent tartozhat. Ugyanazon film több HTTP-tartománykérése nem foglal több helyet. Az ugyanarról az IP-ről indított másik torrent akkor cseréli le a korábbit, ha az új kombináció megengedett; az előző stream olvasását ilyenkor megszakítjuk. Sikertelen váltás – például két HD mellett az egyik eszköz 4K-ra váltana – nem kapcsolja le az eredeti filmet.

A korlát a szerver által kiszolgált aktív torrentlejátszásokat számolja, a már HDD-n meglevő fájlok lejátszását is. Külön IP-címről ugyanaz a torrent is külön helyet foglal. A torrentazonosító alapján közös sorozatcsomagon belüli kérések ugyanazon IP-n egy helyet használnak.

## IP-cím és felbontás

A Node kiszolgáló a TCP-kapcsolat valódi távoli címét olvassa ki, és belső fejlécben adja át a Go-motornak. A kliens által megadott ilyen fejlécet felülírja, a hamisítható `X-Forwarded-For` értékét nem használja az azonosításhoz. Az IPv4 és IPv4-mapped IPv6 címeket a motor normalizálja. A Go-kezelőportot a meglévő telepítés továbbra sem teszi ki a hálózatra.

Ez a jelenlegi, közvetlen helyi hálózati használatra készült. Külső reverse proxy mögött a socket címe a proxy címe lehet, ezért ahhoz külön, megbízható proxykezelés szükséges. Nem az internetes előfizetés közös publikus IP-jét használjuk a helyi TV-k megkülönböztetésére.

A 2160p/2160i, UHD vagy 4K jelölést tartalmazó fájl-/torrentnév kizárólagos 4K-helyet kér. Az 1080p/1080i és a kisebb, névben azonosítható felbontások a kétférőhelyes HD-csoportba kerülnek. Ismeretlen felbontást biztonságosan kizárólagosnak számolunk. Ez név szerinti osztályozás, nem a videó képkockáinak elemzése.

## Mikor szabadul fel a hely?

A hely addig foglalt, amíg van hozzá élő HTTP-videókiszolgálási kérés. Az utolsó kérés lezárása után **60 másodperces türelmi idő** következik. Ez megakadályozza, hogy egy rövid kapcsolatváltás vagy tekerés közben egy másik eszköz elvegye a helyet. Ugyanaz a film ugyanarról az IP-ről ezalatt újra csatlakozhat.

A HEAD ellenőrző kérések és a katalógus-/forráslista-lekérések nem foglalnak helyet. A hibás bájttartomány sem foglal helyet. Ha a TV szüneteltetés közben nyitva tartja a HTTP-kapcsolatot, a hely továbbra is foglalt; nincs külön Stremio Stop-üzenet. A 60 másodperc csak az utolsó kapcsolat lezárása után indul.

A kapacitáson felüli lejátszási kérés HTTP **429** választ és `Retry-After: 60` fejlécet kap. Automatikus várólista nincs. A Stremio ezt általános lejátszási hibaként is mutathatja; a hely felszabadulása után újra kell próbálni. A meglévő, más IP-hez tartozó lejátszás emiatt nem kerül letiltásra.

## Letöltés, visszatöltés és naplózás

Az engedélyezett aktív torrentek letöltése és feltöltése lehetséges. Amíg van foglalt hely, a többi betöltött torrent letöltése és feltöltése szünetel. Ha minden hely felszabadult, a háttérletöltés tiltott marad, a betöltött torrentek seedelhetnek.

A `/playback-limiter` belső állapotválasz most `sessions` listában mutatja az IP-címet, torrentet, minőségi csoportot, élő kérések számát és a türelmi idő végét. Az elfogadott és elutasított kérések IP-címmel és minőségi csoporttal naplózódnak. A Node folyamatosan olvassa a Go gyermekfolyamat kimenetét, így annak naplócsöve nem telik meg olvasatlanul. A HDD-s diagnosztikai szolgáltatás a kimenetet továbbra is kitakarva menti.

## Ellenőrzés

A tiszta Go-korlátozó tesztjei vizsgálják a kizárólagos 4K-t, a két HD-helyet, az egyidejű foglalási versenyt, az IP-nkénti cserét, az elutasított váltás megőrző viselkedését, a párhuzamos tartománykéréseket és a lejáratot.

A külön, csak localhoston elérhető integrációs konténer rövid, mesterséges torrentfájlokkal ellenőrzi a tényleges HTTP-válaszokat, a HEAD-kérések mellékhatásmentességét és a Node → Go IP-továbbítást, hamis kliensfejlécek mellett is. A valós TV-k egyidejű, hosszú lejátszási próbája ettől külön felhasználói ellenőrzés.

2026. október 17-én a teljes Go/TypeScript/kliens Docker-build, az öt Go-teszteset és a 22 elkülönített HTTP/integrációs ellenőrzés sikerült. Az éles telepítés HTTPS-manifestje 0.8.4-et és öt katalógust adott; a torrentmotor végpontjai válaszoltak, a keresés és a forráslista is működött. Az éles ellenőrzés nem indított próbavideót. A külön tesztkonténert eltávolítottuk. A korábbi image és az adatbázismentés megmaradt visszaállításhoz.
