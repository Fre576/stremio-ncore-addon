# Linux Mint, Docker és külső HDD

Ez egy újra felhasználható telepítési minta a 0.8.7 forrásához. Nem tartalmaz jelszót, tokent, adatbázist vagy letöltött videót. A meglévő, működő telepítést a GitHubra feltöltés nem módosítja. Az eredeti telepítés több compose fájlt használ; az itt közölt egyfájlos minta ugyanazt az SSD/HDD elrendezést teszi beállíthatóvá, saját helyben épített image-dzsel.

A telefonos állapotoldal, hibafelismerés és védett takarítás külön gazdagép-szolgáltatásának telepítése: [Filmfigyelő](../control/README-HU.md). Ehhez a kiegészítő Compose-felülírás is szükséges; a fenti alapminta önmagában csak az addon konténerét indítja.

## Elrendezés

- `/addon`: SSD-n lévő állapotkönyvtár, benne konfiguráció, SQLite, cache, statisztikák és torrentleírók.
- `/addon/downloads`: külön bind mount a HDD-n levő videókhoz.
- A Go-motor 8080-as kezelőportját nem tesszük ki a hálózatra. A kliensek a Node HTTPS-kiszolgálóján keresztül kapják a videót.
- A 3000 és 3443 TCP port a HTTP/HTTPS, a 42069 TCP/UDP a peer-forgalom hostoldali portja.

Docker és Compose szükséges. A Compose-nak támogatnia kell az `env_file.format: raw` és `bind.create_host_path: false` mezőket. A `docker compose config --quiet` az adott gépen ellenőrzi ezt. A függőségeket a repository Dockerfile-ja építi; az image nincs ezzel a névvel automatikusan közzétéve Docker-registryben.

## Új telepítés előkészítése

1. Ebben a könyvtárban másold a `.env.example` fájlt `.env` névre és a `ncore.env.example` fájlt `ncore.env` névre.
2. A `.env` fájlban add meg a szerver tényleges helyi IPv4-címét, valamint az SSD-s állapotkönyvtár és a HDD-s letöltési könyvtár abszolút útját. A LAN-címet érdemes a routerben DHCP-foglalással állandósítani.
3. A `ncore.env` fájlban helyben add meg az nCore-belépési adatokat. A `format: raw` miatt az értékekbe nem kell shelles idézőjelet tenni. A fájlt `chmod 600 ncore.env` paranccsal védd; ne töltsd fel GitHubra.
4. A célkönyvtárakat a megfelelő lemezen hozd létre. A HDD-t UUID alapján azonosítsd: `lsblk -f`. Ellenőrizd, hogy valóban ez van csatolva a tervezett útvonalra: `findmnt --mountpoint /media/greti/PS5_GAMES`.
5. Állítsd be a következő pont szerinti automatikus csatolást és Docker-függőséget, mielőtt a szervert állandó használatra elindítod.

## Automatikus csatolás

A jelenlegi telepítés HDD-je exFAT, UUID-je `DE57-7F4D`. Másik lemeznél saját UUID és megfelelő fájlrendszertípus kell. A példát meglévő `/etc/fstab` mellé kell felvenni, a többi bejegyzés megőrzésével; azonos eszközhöz vagy csatolási ponthoz ne hozz létre második, ütköző sort.

```fstab
UUID=DE57-7F4D /media/greti/PS5_GAMES exfat defaults,nofail,nosuid,nodev,uid=1000,gid=1000,fmask=0022,dmask=0022,x-systemd.device-timeout=15s 0 0
```

Az UID/GID a lemezt használó Linux-felhasználó azonosítója legyen. A csatolási könyvtárnak léteznie kell. Az exFAT jogosultságait a mount opciói szabják meg.

A `/etc/systemd/system/docker.service.d/60-stremio-hdd.conf` fájl tartalma ehhez a konkrét lemezhez és útvonalhoz:

```ini
[Unit]
RequiresMountsFor=/media/greti/PS5_GAMES

[Service]
ExecStartPre=/usr/bin/findmnt --noheadings --mountpoint /media/greti/PS5_GAMES --source UUID=DE57-7F4D
```

Ez a **teljes Docker szolgáltatásra** vonatkozik, ezért más konténerek esetén azok indulását is befolyásolja. A jelenlegi laptopon az nCore az érintett konténer. A `nofail` lehetővé teszi a gép további indulását lemez nélkül, de a Docker így is megköveteli a lemezt.

Módosítás után:

```sh
sudo findmnt --verify --tab-file /etc/fstab
sudo systemctl daemon-reload
sudo mount /media/greti/PS5_GAMES
systemctl show docker.service -p Requires -p After
```

Ha a lemez már csatolva van, a `mount` parancs kihagyható. A megfelelő UUID-t a tényleges `findmnt` kimenetben is ellenőrizd.

## Építés és indítás

Ebben a könyvtárban:

```sh
sudo docker compose config --quiet
sudo docker compose build
sudo docker compose up -d
```

A kezelőfelület a `.env` fájlban megadott gép 3000-es HTTP-portján nyitható meg. A varázslóban állítsd be az adminisztrátort és a helyi elérést. Az örökölt helyicím-mentési hiba miatt a Settings oldalon ellenőrizd és mentsd újra a tényleges IPv4-címet. A helyi HTTPS-címet a felület állítja elő; ezen keresztül hozd létre és telepítsd az eszközhöz tartozó személyes kiegészítőt.

Kiegészítőfrissítés után a Stremióban szinkronizálás és alkalmazás-újranyitás szükséges lehet. A TV-nek el kell érnie a laptopot a helyi hálózaton. Ha változott a szerver IP-je, a Docker portkötését, a szerver helyi címét és a telepített addon címét is összhangba kell hozni.

## Meglévő letöltések átköltöztetése

A működő telepítésnél a szerver állt a másolás alatt. A fájlok másolása után rsync tartalmi ellenőrzés és darabszám/méret összevetés történt, majd a HDD-s bind mounttal újralétrejött a konténer. Az eredeti SSD-s könyvtár és az adatbázismentés megmaradt. Ne másolj aktív letöltés közben, és ne töröld az eredetit a másolat ellenőrzése előtt.

A konténer csatolásait `docker inspect --format '{{json .Mounts}}' stremio-ncore-addon` mutatja; a teljes inspect kimenetét ne oszd meg, mert környezeti változókban belépési adat is szerepelhet. Ellenőrizd, hogy `/addon/downloads` tényleg a HDD-s könyvtárra mutat.

A tárhelypanel ebben a kiadásban az SSD-n maradó `ADDON_DIR` helyét mérheti. A HDD tényleges szabad helye: `df -h /media/greti/PS5_GAMES`.

## HDD biztonságos kikapcsolása

1. Állítsd le a konténert: `sudo docker stop --timeout 45 stremio-ncore-addon`.
2. Ezen az egykonténeres gépen állítsd le a Dockert és a socketét: `sudo systemctl stop docker.service docker.socket`.
3. Írasd ki a függő adatokat: `sync -f /media/greti/PS5_GAMES`.
4. Válaszd le a fájlrendszert: `sudo umount /media/greti/PS5_GAMES`. Ha foglalt, előbb szüntesd meg a használatát; ne használj kényszerített leválasztást.
5. Ellenőrizd `lsblk -f` paranccsal az eszköz nevét, majd a megfelelő teljes USB-lemezre futtasd a `udisksctl power-off -b /dev/sdX` parancsot. Az `sdX` helyére az aktuális lemezt kell írni, nem a partíciót.
6. Csak sikeres leválasztás és kikapcsolás után húzd ki.

Visszadugás után ellenőrizd/csatold a megfelelő HDD-t, majd:

```sh
sudo systemctl start docker.service
sudo docker start stremio-ncore-addon
```

Kézi leállítás után a `restart: unless-stopped` nem helyettesíti a kézi újraindítást. A működő laptopon e négy, pontosan meghatározott indító/leállító parancsra jelszómentes sudo lett beállítva; ez nem jelent általános jelszómentes rendszergazdai hozzáférést. Ez a repository-minta nem telepít automatikusan sudoers-szabályt.

## Ellenőrzési határ

A meglévő Linuxos konténer forrásjavításai teljes Docker-builddel és élő HTTPS-lekérésekkel ellenőrzöttek. Az itt közölt, paraméterezhető compose-minta a meglévő elrendezést írja le; önálló, üres gépes újratelepítési próbát nem végeztünk vele. A hidegindítás utáni HDD-csatolást és minden TV-formátumot külön kell ellenőrizni.
