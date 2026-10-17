# 0.8.7 – 1080p.UHD besorolás javítása

Az `1080p.UHD` kiadásnévben az UHD a forráslemezt is jelentheti, miközben az elkészült videó 1080p. A 0.8.6 a megjelenő UHD szót elsőként találta meg, ezért egy ilyen HD-filmet tévesen kizárólagos 4K lejátszásnak számolt.

A 0.8.7 mind a Go lejátszási korlátjában, mind a Node forráslistájának foglaltságjelzésében ugyanazt a sorrendet használja:

1. Egyértelmű `2160p` vagy `4K` jelölés: kizárólagos 4K.
2. Egyértelmű `1080p`, `720p` vagy támogatott alacsonyabb felbontás: HD hely, akkor is, ha UHD szerepel a névben.
3. Csak UHD, illetve ismeretlen felbontás: óvatosságból továbbra is kizárólagos.

Az explicit 2160p/4K és HD szavak együttes előfordulása továbbra is kizárólagosnak számít. A változás nem próbálja a videó teljes tartalmát dekódolni; a kiadás- és fájlnév egyértelmű jelölését kezeli.

A korlát nem változott: **egy 4K film egyedül, vagy legfeljebb két HD film különböző IP-címekről. Egy IP-címhez egy film tartozik.** A harmadik HD és a 4K+HD kombináció tiltása megmaradt. Elutasított filmváltás nem állítja le a már futó filmet.

Regressziós tesztek a tényleges `Coraline.2009.1080p.UHD.BluRay.DD+7.1.DoVi.HDR10.x265.HuN-TRiNiTY` névvel, fordított szósorrenddel, 720p.UHD-val, valódi 2160p/4K-val és bizonytalan névvel. Az elkülönített integrációs rendszer első filmjének fájlnevében most `1080p.UHD` van: a két külön IP-s HD-kérést valódi Node/Go HTTP-próbák ellenőrzik, a harmadik kliens és a közben kért 4K elutasításával együtt.

A javítás ismert besorolási hibát old meg. A Samsung konkrét hálózati elérését és a két tényleges TV párhuzamos lejátszását külön kell ellenőrizni; a mesterséges kétklienses próba ezt nem helyettesíti.

Ellenőrzés: sikeres image-építés, Go-tesztek és 5 foglaltságjelzési teszteset; 57 elkülönített HTTP-integrációs ellenőrzés, valamint 13 éles, lejátszást nem indító ellenőrzés. Az éles szerver és a telefonos állapotoldal 0.8.7 verzióval válaszol. A Stremio-fiók kiegészítőleírója frissítve, a korábbi HTTPS-cím visszaállítva; a többi kiegészítő megőrizve. Az éles ellenőrzés nem törölt letöltést. Részletes eredmény: `0.8.7-validation.json`.
