# 통합과학 진도복습 대시보드

개인용 정적 PWA 대시보드입니다. Netlify에서 GitHub 저장소와 연결하면 push할 때마다 자동 배포됩니다.

## Netlify 연결

1. 이 폴더(`progress-review-dashboard`)를 GitHub 저장소로 올립니다.
2. Netlify에서 `Add new site` -> `Import an existing project`를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. Build command는 비워두고, Publish directory는 `.`로 둡니다.
5. 배포된 주소를 아이폰 Safari에서 열고 `홈 화면에 추가`를 누릅니다.

## 수정 반영 흐름

```text
파일 수정
-> GitHub에 commit/push
-> Netlify 자동 배포
-> 아이폰에서 새로고침
```

## 저장 데이터

진도 섹션 데이터는 각 브라우저의 localStorage에 저장됩니다. PC와 아이폰 데이터가 자동 동기화되지는 않습니다.
