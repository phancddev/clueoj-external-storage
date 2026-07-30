# ClueOJ External Storage — Live E2E & Stress Test Report

> Historical pre-fix stress report retained for incident context. Later R2,
> restore, dependency, and dashboard validation is recorded in
> `FINAL_VALIDATION_REPORT_2026-07-30.md`. Cross-service readiness and ClueOJ
> migration gates remain documented in `docs/clueoj-integration.md`.

Thời gian: 2026-07-30, Asia/Ho_Chi_Minh
Môi trường: Docker standalone, PostgreSQL 16, Rust data plane, TypeScript control plane, Cloudflare R2 bucket thật
Kết luận: **chưa thể production rollout** vì pipeline snapshot Rust → R2 không tạo được snapshot `READY`.

## Tổng quan kết quả

- Live checklist chính (đã hiệu chỉnh hai lỗi của harness bằng targeted rerun): **26 pass, 2 fail, 7 blocked / 35 mục**.
- Targeted regression:
  - `mirror_of: null` / `mirror_root: null`: **4/4 lần trả 502**.
  - Dirty race sau khi bỏ các field null: **400/400 request trả 200** qua 4 lượt × 100; mỗi lượt có đủ `dirty_version=100` và 100 idempotency rows.
  - Một lượt integrated contention trước đó chỉ đạt 15/20 request, 5 request trả 502; hai lượt integrated/targeted tiếp theo không tái hiện.
  - R2 upload + GC targeted rerun: upload, eligible, fenced job, delete object và `collected=true` đều pass.
- Automated suites:
  - Rust: **52/52 pass**.
  - Control plane: **75/75 pass**, TypeScript check pass.
  - Dashboard: **51/51 pass**, TypeScript check và production build pass.
  - Django integration source: `compileall` pass.
  - Standalone và ClueOJ Docker Compose: config valid.

## Số liệu stress

- API mixed load: **2.000 request**, concurrency **100**, **2.000/2.000 HTTP 200**.
- Latency: p50 **25 ms**, p95 **53 ms**, p99 **391 ms**, max **484 ms**.
- Dirty idempotency cùng key/body: **40/40 HTTP 200**, một `dirty_version`, một idempotency row.
- Dirty mutation khác key: lượt chính **20/20 HTTP 200**, version liên tục 1–20.
- Targeted dirty mutation: **4 × 100 = 400/400 HTTP 200**, version liên tục tới 100.
- Login brute force: **10 × 401**, sau đó **4 × 429**; web restart phục hồi health.
- Volume quan sát: total `494384795648`, available `8502210560` bytes, còn khoảng **1,72%**.

## Checklist pass

- [x] Public health, PostgreSQL và Rust process reachable.
- [x] OpenAPI JSON/YAML.
- [x] Reject missing/malformed JWT.
- [x] Service token không được gọi admin API.
- [x] CORS allowlist chặn origin lạ.
- [x] Total/free/available volume hợp lệ.
- [x] Dirty idempotency replay và conflict khác body.
- [x] Dirty generation/version tuần tự trong các lượt tái hiện.
- [x] Catalog reconcile, không biến đổi 52 projection orphan hiện hữu.
- [x] Per-problem usage, organization aggregate và organization quota.
- [x] Snapshot/job list/detail trên cả error state; SSE terminal event.
- [x] Sync changes và dashboard read models.
- [x] Eviction fail-closed khi flag tắt.
- [x] Controlled Rust restart bật/tắt eviction và health recovery.
- [x] Queue pause → pending → cancel → retry → resume; fencing token tăng từ 3 lên 4.
- [x] Non-destructive `atomic_writes` backfill phân trang: 61 processed, 61 skipped, 0 error.
- [x] Retention validation; apply không xóa dữ liệu mới.
- [x] R2 targeted object upload.
- [x] GC eligible → fenced collect → object thật biến mất khỏi R2 → mark `collected=true`.
- [x] Incident command dry-run và history.
- [x] Database invariants: không duplicate generation, không nhiều READY generation, không stranded dirty sau terminal jobs trong dữ liệu test.
- [x] API stress 2.000 request/concurrency 100.
- [x] Login rate limiting và restart recovery.
- [x] Cleanup: không còn local folder, PostgreSQL row, idempotency row, GC mark hoặc R2 object của namespace test.
- [x] Queue đã resume, eviction đã trở lại `false`, các container healthy.

## Fail và rủi ro cần sửa

### P0 — Snapshot lên R2 thật bị chặn hoàn toàn

Mọi snapshot live đều kết thúc `R2_ERROR: r2 error: service error`; không có snapshot `READY`. Cùng credential đó, targeted `rclone` upload/read/delete object thật thành công. Bucket ban đầu trống, nên call đầu tiên của adapter là `HEAD` object chưa tồn tại. Adapter hiện nhận diện not-found bằng cách dò chuỗi `"404"` hoặc `"not found"` trong `e.to_string()`; AWS SDK chỉ trả `"service error"`, nên code abort trước `PUT`.

Hệ quả: auto-push, direct download, restore, eviction thực tế và file-churn E2E đều blocked.

Vị trí liên quan: `rust-data-plane/src/r2.rs:194`.

### P0 — Payload nullable hợp lệ bị coerce thành chuỗi rỗng

Request dirty có `mirror_of: null` và `mirror_root: null` trả 502 với `problems_mirror_of_fkey`. Test tối thiểu tái hiện 4/4. Khi omit hoàn toàn hai field, request pass. Đây là payload bình thường từ ClueOJ nên có thể chặn toàn bộ catalog sync.

Vị trí liên quan: `control-plane/src/schemas.ts:304`, `control-plane/src/routes.ts:166`.

### P1 — Rust watcher lỗi decode generation INT4 → i64

Log live:

`mismatched types; Rust type i64 (INT8) is not compatible with SQL type INT4`

SQL trả `next_generation - 1` từ cột PostgreSQL `INTEGER`, nhưng `DirtySnapshotTargetRow.generation` là `i64`. Watcher không thể acquire dirty snapshot job ổn định.

Vị trí liên quan: `rust-data-plane/src/db.rs:19`, `rust-data-plane/src/db.rs:247`, `rust-data-plane/src/db.rs:408`.

### P1 — Orphan usage được ghi nhưng API serialize lỗi 500

Watcher tạo projection orphan và ghi `problem_usage.local_status = "orphan"`. Response schema chỉ cho `present | missing | partial`, làm Fastify ném:

`The value of '#/properties/local_status' does not match schema definition.`

Vị trí liên quan: `rust-data-plane/src/watcher.rs:213`, `control-plane/src/schemas.ts:73`.

### P1 — Health đang báo xanh khi R2 data path hỏng

`/api/v1/system/health` gọi Rust `/internal/health`, chỉ xác nhận process reachable. Rust có `/internal/ready` kiểm DB + object-store, nhưng control plane không dùng nó. Trong lượt test, dashboard health vẫn `ok` trong khi 100% snapshot R2 fail.

Vị trí liên quan: `control-plane/src/rust-client.ts:106`, `control-plane/src/routes.ts:209`, `rust-data-plane/src/api.rs:65`.

### P1 — Restore chưa áp dụng metadata trong manifest

Không thể chạy live restore vì snapshot bị blocked. Code restore tải từng object và rename file nhưng chưa áp dụng `mode`, cũng chưa dùng `duplicate_of` để tái tạo hardlink. Sau khi sửa R2 cần có test bắt buộc cho executable bit, hardlink identity, owner policy và atomic rollback.

Vị trí liên quan: `rust-data-plane/src/snapshot.rs:447`.

### P1 — Dependency vulnerabilities

- Control plane production dependencies: **10 high** theo `npm audit --omit=dev`, gồm Fastify/static/router/URI path handling.
- Dashboard production dependencies: **2 moderate**, thuộc React Router.
- Không tự động nâng major trong lượt test này.

### P2 — Các vấn đề vận hành

- Origin bị CORS từ chối trả HTTP **500** và log stack; nên trả 403/4xx có cấu trúc.
- Dashboard bundle minified **803,71 kB**, vượt cảnh báo chunk 500 kB.
- `sqlx-postgres 0.7.4` có future-incompatibility warning.
- Disk chỉ còn khoảng **8,5 GB available**; capacity stress bằng dữ liệu lớn là không an toàn.
- Một lượt dirty integrated dưới background scan/snapshot đạt 15/20, nhưng 420 request tái hiện sau đó pass. Cần lặp lại sau khi sửa R2/watcher để xác định có contention bug thật hay không.
- ClueOJ + MariaDB full E2E, Django migration apply và judge restart khi local archive mất chưa chạy vì full ClueOJ stack không hoạt động trong lượt này.
- Credential R2 đã xuất hiện trong chat/log test; cần rotate Access Key/Secret sau khi hoàn tất debug.

## Các mục blocked cần chạy lại sau P0/P1

- [ ] Full-folder snapshot đạt `READY` trên R2.
- [ ] Direct presign và 50 concurrent downloads, checksum canonical archive.
- [ ] Restore khi local folder bị xóa hoàn toàn.
- [ ] Eviction dry-run và actual trên problem cô lập, sau đó restore.
- [ ] Continuous file churn không publish corrupt READY; stable retry recovery.
- [ ] Stale snapshot worker bị fencing trong live R2 pipeline.
- [ ] Restore bảo toàn mode/hardlink và rollback atomic.
- [ ] ClueOJ upload → dirty → snapshot → Celery sync → R2 redirect end-to-end.

## Trạng thái bàn giao

- Storage DB/Rust/Web đều healthy.
- `STORAGE_EVICTION_ENABLED=false`.
- Queue không paused.
- R2 bucket không còn object test.
- Local problem root và PostgreSQL không còn namespace test.
- Không sửa production code trong lượt review/test này.
