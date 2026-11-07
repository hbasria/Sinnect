# PLAN.md — Sinnect çalışma planı

Son güncelleme: 2026-11-07. Bu dosya yapılan işi, yarım kalanı ve sıradaki adımları tutar. Bir iş bitince buradan "Yapılanlar"a taşı.

## Şu an yarım kalan

Yok. Son iş olan workspace terminali, tarayıcıda çalışan geliştirme sürümü (`npm run dev:engine` + `npm run dev:ui`) için tamamlandı. Kullanıcının kararıyla masaüstü paketlemesi sonraya bırakıldı (aşağıda 3. madde).

## Branch düzeni

- Çalışma `develop` branch'inde. `main`'e doğrudan geliştirme yapılmaz; denenmiş işler `main`'e konu bazlı alınır.
- **Dikkat:** Yerel `main` v0.1.5'te, `origin/main` v0.1.7'de (13 commit ileride: Gemini oturumları, self-learning memory, boss/helper oturumları, setup guide). `develop` v0.1.5'ten çıktı ve 18 dosya iki tarafta da değişti (`engine.ts`, `session.ts`, `protocol.ts`, `store.ts`, `Toolbar.tsx` vb.). Taşımaya başlamadan önce `main`'in `origin/main`'e çekilmesi ve çakışmaların ele alınması gerekiyor.

## Öncelikli notlar

- **`secrets.json` izinleri (kullanıcı yapılacak dedi):** `~/.sinnect/secrets.json` `644` izniyle yazılıyor, yani makinedeki diğer kullanıcılar okuyabilir; içinde API anahtarı ve Matrix token'ları var. `engine.ts` içindeki `writeJson` dosya modu vermiyor. Secrets için `0600` ile yazılmalı, mevcut dosyanın izni de düzeltilmeli. Docker'daki `/data` volume'u için de geçerli.

## Sonraki işler (öncelik sırasıyla)

1. **Main'e konu bazlı alma:** Yapılanlar `develop`'ta tek commit halinde. Konular aynı dosyaları paylaştığı için (`engine.ts`, `protocol.ts`, `store.ts`, `Toolbar.tsx`) ayırma elle yapılacak. `main`'e sorulmadan commit ya da push yapılmasın.
2. **Container ve tarayıcıdan erişim** (kullanıcının asıl hedefi: Sinnect Docker'da çalışacak, tarayıcıdan kullanılacak). 2026-11-07'de başlanacaktı, kullanıcı "not et, sonra bakalım" dedi; henüz kod yok. Planlanan adımlar:
   - **Engine adresi:** Engine bugün yalnızca `127.0.0.1`'i dinliyor (`main.ts`). `SINNECT_HOST` env'i eklensin; varsayılan `127.0.0.1` kalsın. Engine UI'ı zaten sunabiliyor (`SINNECT_UI`, `main.ts`'teki http handler).
   - **Token:** Loopback dışı bir adreste dinlerken varsayılan `dev` token'ı reddedilsin; engine güçlü bir `SINNECT_TOKEN` olmadan başlamasın.
   - **UI bağlantısı (`packages/ui/src/engine.ts`, `engineInfo` ve `connect`):**
     - Bugün `ws://127.0.0.1:<port>` sabit. Tauri'de değilse ve `?port` verilmemişse sayfanın kendi origin'ine bağlansın (`location.host`).
     - Sayfa https ise `wss` kullansın (TLS proxy arkası).
   - **Tarayıcıda giriş:**
     - Token `?token=` ile gelirse localStorage'a yazılsın ve adres çubuğundan silinsin (`history.replaceState`).
     - Token yoksa ya da engine reddederse (close kodu 4001/4003) küçük bir "Access token" kartı çıksın.
   - **Claude girişi container'da:** `SINNECT_API_KEY` verilmişse ve kayıtlı ayar yoksa `authMode` varsayılanı `apiKey` olsun (`engine.ts` constructor). Kendi Claude hesabıyla girmek isteyen, yeni terminal panelinden container içinde `claude login` çalıştırabilir.
   - **Claude Code binary'si:** Agent SDK, platforma özel bir paketten bulunuyor (`auth.ts` → `bundledClaude()`, `@anthropic-ai/claude-agent-sdk-linux-<arch>`). Linux'ta `npm ci` bu paketi kuruyor mu, image'da doğrulanmalı.
   - **Dockerfile (çok aşamalı):**
     - Build aşaması: `node:22-bookworm-slim`, `python3 make g++` (node-pty Linux için hazır binary getirmiyor, derlenmeli), `npm ci`, `npm run build`.
     - Çalışma aşaması: aynı base, `git bash ca-certificates curl`, root olmayan kullanıcı. `node_modules`, `packages/engine/dist` ve `packages/ui/dist` kopyalanır.
     - Komut: `node packages/engine/dist/engine.mjs` ile `SINNECT_UI=/app/packages/ui/dist`, `SINNECT_HOST=0.0.0.0`, `SINNECT_DATA=/data`.
     - `/health` ile HEALTHCHECK.
   - **Diğer dosyalar:**
     - `docker-compose.yml`: port 4317, `SINNECT_TOKEN` zorunlu; volume'lar `/data` (ayarlar, workspace, secrets) ve `/workspace` (oturumların çalışacağı kodlar). Konuşma geçmişleri `/data`'da değil, Agent SDK'nın klasöründe (`~/.claude/projects/...`, `CLAUDE_CONFIG_DIR`); Resume'un çalışması için bu klasör de kalıcı olmalı.
     - `.dockerignore`: `node_modules`, `dist`, `src-tauri/target` vb.
   - **Güvenlik:** reverse proxy arkasında TLS; terminali kapatmak için `SINNECT_TERMINAL=0` zaten var.
   - **Önce kontrol:** Bu makinede Docker (ya da OrbStack/colima) kurulu mu? Image'ı yerelde build edip tarayıcıdan denemek için gerekli.
3. **Masaüstü paketlemesi (terminal için):** `scripts/prepare-engine.mjs`, `node_modules/node-pty` klasörünü `src-tauri/resources/engine/node_modules/node-pty` altına kopyalamalı. Yalnızca hedef platformun prebuild'ini al ve `spawn-helper`'ı `chmod 755` yap (imzalı `.app` içinde engine bunu çalışırken yapamaz). Intel Mac, arm runner'da `--target x86_64-apple-darwin` ile build ediliyor; `darwin-x64` prebuild'i bunu karşılıyor. Windows'ta conpty dosyaları prebuild içinde. Windows'ta terminal hiç denenmedi.
4. **Gerçek ortamda deneme:**
   - Company modunu gerçek Claude ile deneme klasöründe çalıştır. `company.sh init` şirketi `~/.crux/companies.toml` dosyasına kaydeder.
   - Matrix'i gerçek bir homeserver ve bot hesabıyla dene.
5. **Matrix, 2. aşamanın kalanı:** Cevaplar düz metin gidiyor; Element Markdown'ı biçimlendirmiyor. `format: 'org.matrix.custom.html'` ve `formatted_body` eklenmeli (örneğin `marked` ile).
6. **Matrix, 3. aşama (çok agent'lı odalar):** Kurallar konuşuldu ve kabul edildi:
   - İnsandan gelen mention'a her zaman cevap verilir.
   - Başka bir Sinnect agent'ından gelen mention yalnızca tuvalde bağlantı ya da görünürlük izin veriyorsa ve Hub üzerinden (uyandırma zinciri ve saatlik limitlerle) işlenir; odaya yalnızca yansıtılır.
   - Sinnect dışı botlar yok sayılır.
   - Bugün başka Sinnect botlarının mesajları tamamen yok sayılıyor (`peers()`).
7. **Coordinator slash komutları:** İzinli kullanıcı listesini coordinator panelinden slash komutla ayarlamak. Engine'de `matrix.allow` mesajı hazır.
8. **Terminal için küçük iyileştirmeler:**
   - Sekme başlığı ve panelde görünen klasör, shell'in açıldığı klasör; `cd` yapınca güncellenmiyor.
   - Agent'lar terminal çıktısını göremiyor; istenirse sonra eklenebilir.
9. **Daha önce görülen zayıf noktalar:**
   - Dosya claim'leri yalnızca Edit/Write araçlarında alınıyor; Bash ile yazma koordinasyonu atlatıyor.
   - Bütçe limiti yalnızca o anki turu durduruyor; kuyruktaki turları ve uyandırmaları engellemiyor.
   - Hub mesaj geçmişi workspace'e kaydedilmiyor.
10. **Fikir listesi:** oturum başına git worktree, kartta diff görünümü, pipeline/handoff bağlantıları, oturum başına bütçe, ortak not panosu, oturum çatallama, Linux build.

## Yapılanlar (`develop`'ta, `main`'e alınmadı)

| İş | Ana dosyalar | Doğrulama |
| --- | --- | --- |
| Crux agent seçici: son kullanılan agent hatırlanır, şablonlara girer, kartta emoji | `engine/src/crux.ts`, `ui/src/panels/SetupCard.tsx`, Settings'te "Crux folder" | Testler; demo modunda tarayıcıda |
| Crux company modu: coordinator, onboarding, `hub_spawn`, onaylı ekip açma, aileler, bağlantılar | `engine/src/crux.ts` (`coordinatorPrompt`), `engine.ts` (`spawn`), `session.ts` (`spawnSession`), `ui/src/actions.ts`, `Toolbar.tsx` (CompanyRow) | `company.test.ts`; demo coordinator senaryosuyla tarayıcıda |
| Matrix sohbeti: oturum başına bot, mention ve thread, oda başına izinli liste, "yazıyor…", token `secrets.json`'da, Resume'da yeniden bağlanma | `engine/src/matrix.ts`, `engine.ts`, `session.ts`, `ui/src/panels/MatrixDialog.tsx` | `matrix.test.ts` (sahte homeserver); yerel sahte sunucuyla tarayıcıda uçtan uca |
| Workspace: görünür silme ve onay, açık workspace silinince board ve terminaller temizlenir, "New", Unicode dosya adları | `ui/src/workspace.ts`, `Toolbar.tsx`, `engine.ts` (`safeName`) | `workspaces.test.ts`; tarayıcıda |
| Workspace terminali (tarayıcı/dev sürümü): engine'de node-pty ile gerçek shell, WebSocket üzerinden xterm.js, altta sekmeli panel | `engine/src/terminals.ts`, `ui/src/terminal.ts`, `ui/src/panels/TerminalPanel.tsx` | `terminals.test.ts` (sahte shell ve gerçek node-pty); tarayıcıda (aşağıda) |

### Terminal ayrıntıları

- **Açma yolları:**
  - Araç çubuğundaki terminal butonu ya da Ctrl+` (göster/gizle; hiç sekme yoksa yeni sekme açar).
  - Panelde "+" butonu. Varsayılan klasör: company modunun kökü, yoksa son kullanılan klasör, yoksa `~`.
  - Oturum kartında fare üstüne gelince çıkan terminal ikonu ve genişletilmiş oturum başlığındaki "Terminal" butonu. İkisi de oturumun klasöründe, oturumun adıyla açar.
  - Komut paletinde "New terminal" ve "Show or hide terminals".
- **Engine (`terminals.ts`):**
  - Mac'te `$SHELL -l` ile login shell açar, `TERM=xterm-256color`; `SINNECT_TOKEN` ve `SINNECT_API_KEY` shell ortamına geçmez.
  - Çıktıyı 16 ms toplayıp gönderir, son 200 KB'ı tutar. Böylece sayfa yenilenince ya da yeniden bağlanınca shell çıktısıyla birlikte geri gelir.
  - Klasör yoksa ev klasöründe açar, terminale not yazar, sekmeyi açıldığı klasörün adıyla adlandırır.
  - node-pty'nin `spawn-helper` dosyasını yüklerken çalıştırılabilir yapar; npm install script'ini çalıştırmadığı için gerekli.
  - node-pty yüklenemezse ya da `SINNECT_TERMINAL=0` ise panel nedenini gösterir, uygulama çökmez.
  - esbuild'de node-pty dışarıda bırakıldı (`--external:node-pty`).
- **UI:**
  - Çıktı store'a girmiyor; `terminal.ts` içinde tutuluyor.
  - Shell (Tab ile tamamlama) ve Ctrl+F terminal içindeyken shell'e gidiyor, komut paletini açmıyor.
  - Panel yüksekliği sürüklenerek değişiyor ve hatırlanıyor.
  - Shell kapanınca "Restart" butonu çıkıyor.
- **Workspace:** Sekmeler (klasör ve başlık) kaydediliyor ve yüklenince shell'ler yeniden başlıyor; çalışan shell'in kendisi kaydedilmiyor. New, silme ve yükleme bütün terminalleri kapatıyor.
- **Tarayıcıda denenenler:**
  - Komut çalıştırma ve renkler.
  - Tab ile tamamlama ve Ctrl+F'nin shell'de kalması.
  - Panel genişliğine göre `tput cols`.
  - Sayfa yenilenince aynı shell'in çıktısıyla geri gelmesi.
  - Oturum kartından açma.
  - İki sekme, gizle/göster ve New.
- **Elle denerken dikkat:** Tarayıcı paneli gizliyken animasyonlar donar; paneller açılmış görünmez ama state doğrudur.
- **Vite canlı yenilemesi (dev modunda önemli, kullanıcı Sinnect'i dev modunda kullanıyor):** Dosya değişince Vite modülleri sayfa açıkken yeniden çalıştırır. Önceden bu, ikinci bir engine bağlantısı açıp terminalde her şeyi iki kez yazdırıyordu. Şu korumalar var:
  - `App.tsx`: açılış koruması `window.__sinnectBooted` üzerinde.
  - `engine.ts` (UI): `connect()` ikinci kez bağlanmıyor; dosya değişirse sayfa tamamen yenileniyor.
  - `terminal.ts`: tamponlar ve tek dinleyici `window.__sinnectTerminals` üzerinde; modülün yeni kopyası eskisinin dinleyicisini değiştiriyor.
  - Yeni bir modül seviyesinde dinleyici eklerken aynı deseni kullan.

Toplam: typecheck temiz, 53 test geçiyor (engine 47, UI 6), build başarılı.
