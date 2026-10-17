# nCore 0.8.5 – megszakított videókérések kezelése

A 0.8.5 megtartja a [0.8.4 IP-alapú szabályait](VERZIO-0.8.4-HU.md): egy IP-címhez egy torrent, a teljes szerveren pedig vagy egy kizárólagos 4K, vagy legfeljebb két HD-lejátszás tartozhat. A korábban működő keresési, HTTPS-, HDD- és naplózási funkciók is megmaradnak.

## Javított hiba

2026. október 17-én a 0.8.4 éles naplójában megszakított videókapcsolat után `UnhandledPromiseRejection: Error: aborted` jelent meg. A Node folyamat kilépett, ezért a Docker újraindította a konténert. Az ismétlődő klienspróbálkozások újraindulási kört okoztak. Ez külön hiba a korábbi, olvasatlan Go-naplókimenet miatti lehetséges elakadástól.

A használt HTTP-adapter aszinkron válaszkiszolgálása elutasított Promise-t adhat vissza. A Node HTTP-eseménykezelője önmagában nem kezeli ezt az elutasítást. A 0.8.5 a HTTP- és HTTPS-kiszolgáló kéréskezelőjét külön védőréteggel hívja: kezeli a szinkron kivételt és a később elutasított Promise-t is. A hibás válasz kapcsolatát lezárja és naplózza, a többi kérés és a szerver futása folytatódik.

Ez nem globális `unhandledRejection` elnyomás: más, a kéréskezelésen kívüli programhibák változatlanul valódi hibák. A kliens megszakításának továbbítása a torrentmotor felé megmarad, hogy a lezárt videókérés ne foglaljon korlátlanul erőforrást. Az utolsó élő kérés után továbbra is 60 másodperces türelmi idő következik.

## Ellenőrzés

- A Docker-buildben lefutott a Go tesztcsomag, a TypeScript-fordítás, a két új kéréskezelési teszt és a kliensbuild.
- A kéréskezelési tesztek szinkron és aszinkron hibát, illetve tíz egymást követő valódi HTTP-kliensmegszakítást vizsgálnak.
- A külön integrációs konténer 33 ellenőrzése megtartotta a korábbi IP-/minőségi kombinációk és a hamis IP-fejlécek vizsgálatát.
- Egy 64 MiB-os mesterséges torrentfájl Node → Go proxyzott lejátszását tízszer megszakítottuk az első 1024 bájt után. Minden alkalom után a szerver válaszolt, és a konténer indulási ideje változatlan maradt.
- A tesztekben nem használtunk valódi filmet vagy nCore-belépési adatot. A valós TV-s, hosszú lejátszás ettől külön ellenőrzés.

A rövid, sikeres bájttartomány-lekérés önmagában nem vizsgálja a megszakítást; ez volt a korábbi tesztelés hiánya. Az új tesztek ezt a hibahelyzetet kifejezetten lefedik.
