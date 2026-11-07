# AGENTS.md — Sinnect

Sinnect, Claude oturumlarını sonsuz bir tuvalde çalıştıran masaüstü uygulaması. Bu dosya bu depoda çalışan agent'lar (ve insanlar) için: yapı, komutlar, kurallar ve işin şu anki durumu.

**Yeni bir oturuma başlarken önce [PLAN.md](PLAN.md)'yi oku.** Yarım kalan iş ve sıradaki adımlar orada.

## Yapı

| Parça | Ne | Nerede |
| --- | --- | --- |
| Kabuk | Tauri 2 (Rust). Pencereyi açar, engine'i rastgele port ve token ile başlatır. | `src-tauri/` |
| Engine | Node süreci. Claude Agent SDK ile oturumları çalıştırır, Hub'ı barındırır, UI ile `127.0.0.1` üzerinden WebSocket ile konuşur. | `packages/engine/` |
| UI | React + React Flow + Motion + Tailwind, state zustand'da. | `packages/ui/` |

Önemli engine dosyaları:

- `protocol.ts`: UI ile engine'in paylaştığı mesaj tipleri. UI bunu doğrudan import eder, Node'a özgü import koyma.
- `engine.ts`: oturumlar, istemler, ayarlar, workspace dosyaları, Matrix köprüleri, `spawn`.
- `hub.ts`: token harcamayan koordinasyon: roster, mesajlar, dosya claim'leri, pazarlık, uyandırma limitleri.
- `session.ts`: ortak oturum mantığı (`BaseSession`), `real-session.ts` (Agent SDK) ve `mock-session.ts` (demo modu).
- `crux.ts`: Crux agent listesi, agent ve coordinator sistem istemleri.
- `matrix.ts`: oturum başına Matrix botu (düz `fetch`, yalnızca şifresiz odalar).
- `terminals.ts`: node-pty ile gerçek shell'ler; çıktı WebSocket'ten UI'daki xterm.js paneline akar.

## Komutlar

```bash
npm install
npm run typecheck      # engine + ui
npm test               # engine + ui testleri
npm run build
npm run dev:mock       # demo engine, token harcamaz (:4317)
npm run dev:ui         # vite (:5173)
npm run app:dev        # Tauri penceresi (Rust gerekir)
```

Geliştirme ipuçları:

- `dev:mock` ve `dev:engine` varsayılan olarak `~/.sinnect` klasörünü kullanır; bu, kullanıcının gerçek ayar ve workspace verisidir. Deneme yaparken `SINNECT_DATA=<geçici klasör>` ver.
- Kullanıcının kendi dev sunucuları genelde 4317 ve 5173'te açıktır. Kendi denemelerin için başka port kullan: `SINNECT_PORT=4417 SINNECT_MOCK=1 SINNECT_DATA=... npx tsx src/main.ts` ve `npx vite --port 5273`, sonra `http://localhost:5273/?port=4417&token=dev`.
- Matrix'i gerçek sunucu olmadan denemek için `packages/engine/test/fake-homeserver.ts` var; testler ve elle deneme için kullanılabilir.
- Masaüstü uygulamasının verisi `~/Library/Application Support/dev.sinnect.app/` altında.

## Kurallar

- Çevredeki kodun stiline uy: kısa, "neden"i anlatan yorumlar; isimlendirme ve yapı aynı kalsın.
- Token tasarruflu tasarım esastır: oturumlar birbirinin transkriptini görmez, uyandırmalar Hub limitlerinden geçer. Agent'tan agent'a yeni bir kanal eklerken (Matrix gibi) bu limitleri atlatma.
- Gizli bilgiler (API key, Matrix token) yalnızca engine'in `secrets.json` dosyasında durur; workspace dosyasına ve UI'a girmez.
- Kullanıcı açıkça istemeden commit atma, push yapma.
- Bu makine Crux kullanıyor (`~/CLAUDE.md`). Bu depo `dotlabs/software` takımına ait.

## Durum (2026-11-07)

Geliştirme `develop` branch'inde; aşağıdakiler orada ve henüz `main`'e alınmadı:

1. **Crux agent seçici:** Yeni oturum ekranında agent combo box'ı; agent'ın `AGENT.md`'si sistem istemine eklenir.
2. **Crux company modu:** Settings'te workspace başına anahtar; coordinator oturumu onboarding yapar, `hub_spawn` ile ekip oturumları açar.
3. **Matrix sohbeti:** Oturum başına "Enable chat"; mention'lara thread içinde cevap, oda başına izinli kullanıcı listesi.
4. **Workspace düzeltmeleri:** Görünür silme butonu ve onay, açık workspace silinince board temizlenir, "New" butonu, Türkçe dosya adları.
5. **Workspace terminali:** Altta sekmeli panel, engine'de node-pty. Tarayıcıda çalışan dev sürümü için tamam; masaüstü paketlemesi ve container sonraki işler.

Doğrulama: typecheck temiz, 53 test geçiyor, build başarılı. Demo modunda ve sahte Matrix sunucusuyla tarayıcıda denendi. Gerçek Claude oturumuyla ve gerçek Matrix sunucusuyla **denenmedi**.
