# PixivBO

Pixiv 북마크를 로컬에서 정리하고, 태그를 미리 검토한 뒤 실제 Pixiv 계정에 반영할 수 있는 도구입니다.

이 프로젝트는 OpenAI Codex 5.4-assisted development 방식으로 개발되었습니다.

## 이 프로그램으로 할 수 있는 일

- Pixiv 북마크 전체 불러오기
- 공개 / 비공개 북마크를 함께 시간순으로 보기
- Pixiv 북마크 태그 목록과 개수 확인
- Pixiv 태그를 내 계정 태그 규칙으로 정리
- 여러 작품을 한 번에 선택해서 태그 추가 / 치환
- 적용 전에 미리보기로 변경 내용 확인
- 썸네일을 로컬에 캐시해서 조금 더 편하게 보기

## 먼저 준비할 것

1. Windows PC
2. Python 3.11 이상
3. Pixiv에 로그인된 브라우저
4. Pixiv 쿠키 파일 또는 세션 정보

Python이 설치되어 있는지 확인하려면 PowerShell 또는 명령 프롬프트에서 아래 명령을 입력해 보세요.

```powershell
py -3 --version
```

버전이 나오면 준비된 것입니다.

## 설치 방법

1. 이 저장소를 다운로드하거나 압축 해제합니다.
2. 폴더 안으로 들어갑니다.
3. `launch_pixivbm.bat`를 실행합니다.

처음 실행하면 `pixiv_config.example.json`을 바탕으로 `pixiv_config.json`이 자동으로 만들어집니다.

## 처음 실행하면 왜 북마크가 안 보이나요?

정상입니다.  
공유용 저장소에는 여러분의 Pixiv 로그인 정보가 들어 있지 않기 때문에, 처음에는 UI만 열리고 실제 북마크는 비어 있을 수 있습니다.

북마크를 가져오려면 본인 계정의 로그인 정보를 직접 넣어야 합니다.

## Pixiv 로그인 설정 방법

이 프로그램은 앱 안에서 아이디/비밀번호로 로그인하지 않습니다.  
`pixiv_config.json`에 쿠키 기반 인증 정보를 넣는 방식입니다.

사용 가능한 방식은 3가지입니다.

- `cookie_file`: `pixiv.net_cookies.txt` 같은 Netscape 형식 쿠키 파일 사용
- `raw_cookie`: 브라우저 쿠키 문자열 직접 입력
- `php_sessid`: `PHPSESSID`만 직접 입력

가장 쉬운 방법은 `cookie_file` 방식입니다.

### 예시

```json
{
  "base_url": "https://www.pixiv.net",
  "bookmarks_endpoint": "https://www.pixiv.net/ajax/user/bookmarks/illust",
  "bookmark_detail_endpoint": "https://www.pixiv.net/ajax/illust",
  "bookmark_update_endpoint": "https://www.pixiv.net/ajax/illusts/bookmarks/edit",
  "auth_mode": "cookie",
  "raw_cookie": "",
  "cookie_file": "pixiv.net_cookies.txt",
  "refresh_token": "",
  "php_sessid": "",
  "user_id": "",
  "user_agent": "Mozilla/5.0",
  "language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "request_timeout_seconds": 20
}
```

## 실행 방법

가장 쉬운 방법:

```powershell
py -3 launch_pixivbm.py
```

또는 배치 파일:

```powershell
launch_pixivbm.bat
```

정상 실행되면 브라우저에서 아래 주소가 열립니다.

[http://127.0.0.1:8000/index.html](http://127.0.0.1:8000/index.html)

## 사용 순서

1. 프로그램 실행
2. 상단의 `세션 확인`으로 로그인 상태 점검
3. `새 북마크 가져오기` 클릭
4. 왼쪽 태그 목록이나 검색창으로 작품 모으기
5. 중앙에서 작품 선택
6. 오른쪽 / 하단 패널에서 태그 추가, 치환, 추천 확인
7. 마지막에 `Pixiv에 적용`으로 반영

## 자주 쓰는 명령어

직접 실행하고 싶은 경우:

```powershell
py -3 -m backend.cli --config pixiv_config.json serve-ui --host 127.0.0.1 --port 8000
```

세션 확인:

```powershell
py -3 -m backend.cli --config pixiv_config.json validate-session
```

북마크 다시 가져오기:

```powershell
py -3 -m backend.cli --config pixiv_config.json fetch-all-bookmarks --page-size 48
```

테스트 실행:

```powershell
py -3 -m unittest discover -s tests
```

## 폴더 설명

- `backend/`: 서버와 Pixiv 통신 코드
- `assets/`: 아이콘 파일
- `data/`: 실행 후 생성되는 로컬 데이터 폴더
- `tests/`: 테스트 코드
- `launch_pixivbm.py`: 실행 스크립트
- `launch_pixivbm.bat`: Windows용 실행 배치 파일
- `pixiv_config.example.json`: 예제 설정 파일
- `tag_mappings.example.json`: 예제 태그 매핑 파일

## 주의사항

- `pixiv_config.json`은 개인 설정 파일입니다. GitHub에 올리지 마세요.
- `pixiv.net_cookies.txt`는 개인 로그인 쿠키 파일입니다. 절대 공유하지 마세요.
- `data/` 아래 파일에는 북마크 정보와 작업 로그가 저장될 수 있습니다.
- 이 저장소에는 예제 파일만 들어 있고, 실제 계정 정보는 포함되어 있지 않습니다.

## 면책 조항

- 이 도구는 개인용 보조 도구입니다.
- 사용으로 인해 발생하는 계정 문제, 잘못된 태그 적용, 데이터 손실에 대한 책임은 사용자에게 있습니다.
- Pixiv 정책 변경, 로그인 세션 만료, 응답 형식 변경으로 일부 기능이 동작하지 않을 수 있습니다.
- 중요한 작업 전에는 반드시 미리보기와 소량 테스트를 먼저 권장합니다.

## 문제 해결

### 1. 배치 파일을 실행했는데 아무 것도 안 뜹니다

- Python이 설치되어 있는지 확인하세요.
- `py -3 --version`이 동작하는지 먼저 확인하세요.
- `pixiv_config.json`이 자동 생성되었는지도 확인하세요.

### 2. 프로그램은 열리는데 북마크가 안 보입니다

- 로그인 정보가 아직 없는 상태일 수 있습니다.
- `pixiv_config.json`에 쿠키 파일 또는 세션 정보를 넣었는지 확인하세요.
- 상단의 `세션 확인` 버튼으로 상태를 먼저 확인하세요.

### 3. 로그인은 됐는데 예전 데이터가 보입니다

- 브라우저에서 `Ctrl+F5`로 새로고침하세요.
- 다시 `새 북마크 가져오기`를 눌러 최신 북마크를 불러오세요.

## 라이선스

이 프로젝트는 MIT License를 따릅니다. 자세한 내용은 `LICENSE` 파일을 확인하세요.
