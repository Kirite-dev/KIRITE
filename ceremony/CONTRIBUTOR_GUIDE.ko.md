# KIRITE phase-2 ceremony 기여 가이드

KIRITE membership 회로의 phase-2 신뢰 설정 ceremony 에 한 번 contribution 추가하는 절차입니다. 전체 5분 정도 걸림.

## 무엇을 하는지

직전 contributor 가 만든 zkey 를 받아서, 거기에 자기만의 random entropy 를 섞어 새 zkey 를 만들고 chain 한 단계 깊게 만드는 일. 본인 contribution 이 들어간 후에는, 공격자가 가짜 proof 를 만들려면 chain 의 **모든 contributor** (본인 포함) 가 entropy 를 안 지운 상태여야 함. 본인이 정직하게 entropy 를 폐기하면 chain 전체가 안전해짐.

## 준비물

- Node.js 20 이상
- 약 50 MB 디스크
- attestation 에 박을 이름 또는 핸들 (트위터 핸들 OK)
- "contributed 했다" 는 공개 진술 1개 (트윗, GitHub PR 댓글 등 검증 가능한 것)

## 절차

### 1. snarkjs 설치

```bash
npm install -g snarkjs
```

이미 있으면 `snarkjs --version` 으로 0.7+ 확인.

### 2. 최신 zkey 다운로드

[ceremony status 표](./README.md#status-table) 에서 최신 round 번호 확인. 그 파일 받음:

```bash
wget https://raw.githubusercontent.com/Kirite-dev/KIRITE-layer/main/ceremony/rounds/round_<N>.zkey
```

`<N>` 을 최신 round 번호로 치환. 예: round_3 이 최신이면 `round_3.zkey` 받고 본인 결과물은 `round_4.zkey`.

### 3. Contribute

contribution 명령 실행. attestation 에 박을 이름/핸들 고름:

```bash
snarkjs zkey contribute round_<N>.zkey round_<N+1>.zkey \
  --name="<your name or handle>" \
  -v
```

snarkjs 가 entropy 입력 프롬프트 띄우면 **키보드 막 두드림**. 아무거나 OK. 엔터 치면 OS RNG 와 섞어서 새 zkey 만듦. 약 1분 소요.

터미널에 contribution hash (긴 hex 문자열) 가 출력됨. 그거 보관. attestation hash 임.

### 4. 새 zkey 의 sha256 계산

```bash
sha256sum round_<N+1>.zkey
```

digest 보관. attestation 파일에 들어감.

### 5. Attestation 작성

`round_<N+1>.attestation.txt` 만들고 아래 템플릿 채움:

```
round: <N+1>
contributor: <your name or handle>
date: <YYYY-MM-DD>
sha256(zkey): <step 4 의 digest>
contribution_hash: <step 3 의 hash>
public_statement: <트위터 / GitHub 댓글 링크 — 본인 확인용>

(선택) machine notes: 예) "fresh ubuntu VM, OS RNG only, VM destroyed after"
```

### 6. PR 올리기

repo fork → 다음 두 파일을 `ceremony/rounds/` 에 push:

- `round_<N+1>.zkey`
- `round_<N+1>.attestation.txt`

PR 제목: `ceremony: round <N+1> contribution by <your handle>`

리뷰어가 `snarkjs zkey verify` 돌려보고 통과하면 merge. ceremony README 의 status 표가 자동 업데이트됨.

### 7. Entropy 폐기

이게 진짜 중요한 단계. entropy 와 닿은 모든 흔적 제거:

- 터미널 scrollback 에서 키보드 입력 부분 지움
- 로컬 `round_<N>.zkey`, `round_<N+1>.zkey` 디스크에서 삭제 (원하면)
- VM 에서 돌렸으면 VM destroy
- 가장 중요: entropy 어디에도 적어두지 말 것

ceremony 가 작동하는 본질이 이거임. **단 한 명이라도 정직하게 폐기**하면 공격자가 chain 깰 수 없음.

### 8. 공개 진술

트위터, 디스코드, GitHub 댓글 등 어디든 한 곳에 박음:

> contributed to KIRITE phase-2 ceremony round <N+1>
> sha256(zkey): <digest>
> contribution_hash: <hash>

이 공개 진술이 attestation 의 이름이 진짜 본인 것임을 커뮤니티가 검증하는 근거.

## 본인 contribution 직접 검증

체인이 정상인지 확인하고 싶으면:

```bash
snarkjs zkey verify \
  circuits/membership.r1cs \
  circuits/build/pot14_final.ptau \
  round_<N+1>.zkey
```

`ZKey OK!` 나오면 powers-of-tau 부터 본인 contribution 까지 전체 chain 정상.

## 질문

[@KiriteDev](https://x.com/KiriteDev) DM 또는 PR 댓글.

斬り手。
