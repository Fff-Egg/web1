import type { Provider, FetchType } from "../server/db/schema.js";

/**
 * UI/server catalog of providers. The dashboard renders a dropdown from this;
 * the server uses it to derive fetchType and whether a credentialRef is needed
 * when a source is created. Keep in sync with the adapters that are registered.
 */
export interface ProviderPreset {
  provider: Provider;
  /** Display name in the dropdown. */
  label: string;
  /** Default fetch_type assigned when a source of this provider is created. */
  fetchType: FetchType;
  /** Whether this provider needs a stored login session (shows credentialRef UI). */
  requiresAuth: boolean;
  /** Placeholder for the identifier input. */
  placeholder: string;
  /** Short helper text shown under the input. */
  hint: string;
  /** Whether the collecting adapter is implemented yet (vs. coming in a later phase). */
  implemented: boolean;
}

export const PROVIDER_PRESETS: Record<Provider, ProviderPreset> = {
  generic_rss: {
    provider: "generic_rss",
    label: "Generic RSS",
    fetchType: "rss",
    requiresAuth: false,
    placeholder: "https://example.com/feed.xml",
    hint: "임의의 RSS 피드 URL",
    implemented: true,
  },
  naver_blog: {
    provider: "naver_blog",
    label: "네이버 블로그",
    fetchType: "rss",
    requiresAuth: false,
    placeholder: "ranto28  또는  blog.naver.com/ranto28",
    hint: "블로그 ID (공개글 RSS). rss.blog.naver.com/{id}.xml 로 수집",
    implemented: true,
  },
  hankyung: {
    provider: "hankyung",
    label: "한국경제",
    fetchType: "rss",
    requiresAuth: false,
    placeholder: "https://www.hankyung.com/feed/economy",
    hint: "섹션 RSS URL. 홈 URL을 넣으면 기본 섹션(economy)으로 수집",
    implemented: true,
  },
  substack: {
    provider: "substack",
    label: "Substack",
    fetchType: "rss",
    requiresAuth: false,
    placeholder: "xxx.substack.com  또는  https://xxx.substack.com",
    hint: "RSS로 글 목록/미리보기 수집. 유료 구독글 전문은 추가 후 로그인하면 수집.",
    implemented: true,
  },
  x: {
    provider: "x",
    label: "X (Twitter)",
    fetchType: "rss",
    requiresAuth: false,
    placeholder: "@handle  (예: jukan05)",
    hint: "로그인 없이 공개 글만 수집. 환경변수 X_RSS_BRIDGE 설정 또는 소스의 rssUrl 에 RSS 주소 입력 필요.",
    implemented: true,
  },
  naver_premium: {
    provider: "naver_premium",
    label: "네이버 프리미엄콘텐츠",
    fetchType: "scrape_auth",
    requiresAuth: true,
    placeholder: "https://contents.premium.naver.com/...",
    hint: "유료 구독 채널 URL. 추가 후 네이버 아이디로 로그인하면 본문 수집.",
    implemented: true,
  },
  fanding: {
    provider: "fanding",
    label: "Fanding",
    fetchType: "scrape_auth",
    requiresAuth: true,
    placeholder: "https://fanding.kr/@sesang101/",
    hint: "크리에이터 URL. 멤버 전용글은 추가 후 로그인하면 수집.",
    implemented: true,
  },
  generic_scrape: {
    provider: "generic_scrape",
    label: "Generic Scrape",
    fetchType: "scrape",
    requiresAuth: false,
    placeholder: "https://example.com/list",
    hint: "동적 페이지 스크래핑. (Phase 5)",
    implemented: false,
  },
};

export const PROVIDER_LIST: ProviderPreset[] = Object.values(PROVIDER_PRESETS);
