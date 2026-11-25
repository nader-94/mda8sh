// =====================================================
// مداقش - محرك اللعبة (Game Engine)
// =====================================================
'use strict';

// ترتيب قوة الأوراق (من الأقوى إلى الأضعف)
const CARD_RANK = { 'A': 14, 'K': 13, 'Q': 12, 'J': 11, '10': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5 };
const CARD_NAMES_AR = { 'A': 'آكة', 'K': 'شايب', 'Q': 'بنت', 'J': 'ولد', '10': '10', '9': '9' };

// أنواع المشاريع (من الأقوى إلى الأضعف)
const PROJECT_TYPES = {
  FOUR_OF_A_KIND: 4,  // رباعي
  THREE_OF_A_KIND: 3, // ثلاثي
  TWO_PAIR: 2,        // مزدوج
  ONE_PAIR: 1,        // ثنائي
  HIGH_CARD: 0        // عشوائي
};

// البيركات الثلاثة المعتمدة فقط
const PERKS = [
  { id: 'half_loss', nameAr: 'نصف الخسارة', descAr: 'إذا خسرت المداقشة، تخسر نصف مبلغ دخولك فقط' },
  { id: 'double_win', nameAr: 'مضاعفة المكسب', descAr: 'المبلغ الذي تكسبه في هذه الجولة يتضاعف' },
  { id: 'joker', nameAr: 'الجوكر', descAr: 'يستطيع الجوكر إكمال أي مجموعة من الأوراق' }
];

/**
 * بناء مجموعة الأوراق بناءً على عدد اللاعبين
 */
function buildDeck(playerCount) {
  const ranks = ['A', 'K', 'Q', 'J'];
  if (playerCount >= 5) ranks.push('10');
  if (playerCount >= 6) ranks.push('9');

  const deck = [];
  for (const rank of ranks) {
    for (let i = 0; i < 4; i++) {
      deck.push(rank);
    }
  }
  return deck;
}

/**
 * خلط المجموعة (Fisher-Yates)
 */
function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * توزيع 4 أوراق لكل لاعب
 */
function dealCards(players, deck) {
  const shuffled = shuffleDeck(deck);
  const hands = {};
  players.forEach((pid, idx) => {
    hands[pid] = shuffled.slice(idx * 4, idx * 4 + 4);
  });
  return hands;
}

/**
 * اختيار بيرك عشوائي
 */
function randomPerk() {
  return PERKS[Math.floor(Math.random() * PERKS.length)];
}

/**
 * تحليل المشروع من أربع أوراق
 * يأخذ بعين الاعتبار الجوكر (يكمل أفضل مجموعة ممكنة من الأوراق)
 */
function analyzeHand(cards, hasJoker = false) {
  const counts = {};
  let jokerUsed = false;

  for (const c of cards) {
    if (c === 'JOKER') {
      jokerUsed = true;
      continue;
    }
    counts[c] = (counts[c] || 0) + 1;
  }

  // إذا كان اللاعب يملك بيرك الجوكر، يكمل أفضل رتبة موجودة لرفع قوة المشروع
  if (hasJoker && !jokerUsed) {
    const bestRank = Object.keys(counts).sort(
      (a, b) => (counts[b] - counts[a]) || (CARD_RANK[b] - CARD_RANK[a])
    )[0];
    if (bestRank) counts[bestRank]++;
  }

  const values = Object.values(counts).sort((a, b) => b - a);
  const ranks = Object.keys(counts).sort(
    (a, b) => (counts[b] - counts[a]) || (CARD_RANK[b] - CARD_RANK[a])
  );

  let type, primaryRank, secondaryRank;

  if (values[0] >= 4) {
    type = PROJECT_TYPES.FOUR_OF_A_KIND;
    primaryRank = ranks[0];
  } else if (values[0] === 3) {
    type = PROJECT_TYPES.THREE_OF_A_KIND;
    primaryRank = ranks[0];
    // أعلى ورقة متبقية (حتى لو كانت زوجاً مع الجوكر)
    secondaryRank = ranks.filter(r => r !== primaryRank).sort((a, b) => CARD_RANK[b] - CARD_RANK[a])[0];
  } else if (values[0] === 2 && values[1] === 2) {
    type = PROJECT_TYPES.TWO_PAIR;
    const pairs = ranks.filter(r => counts[r] === 2).sort((a, b) => CARD_RANK[b] - CARD_RANK[a]);
    primaryRank = pairs[0];
    secondaryRank = pairs[1];
  } else if (values[0] === 2) {
    type = PROJECT_TYPES.ONE_PAIR;
    primaryRank = ranks[0];
    secondaryRank = ranks.filter(r => r !== primaryRank).sort((a, b) => CARD_RANK[b] - CARD_RANK[a]);
  } else {
    type = PROJECT_TYPES.HIGH_CARD;
    primaryRank = ranks.sort((a, b) => CARD_RANK[b] - CARD_RANK[a])[0];
    secondaryRank = ranks.sort((a, b) => CARD_RANK[b] - CARD_RANK[a]);
  }

  return { type, primaryRank, secondaryRank, counts, ranks };
}

/**
 * مقارنة مشروعين - يرجع 1 إذا فاز a، -1 إذا فاز b، 0 إذا تعادلا
 */
function compareHands(handA, handB, jokerA = false, jokerB = false) {
  const a = analyzeHand(handA, jokerA);
  const b = analyzeHand(handB, jokerB);

  if (a.type !== b.type) return a.type > b.type ? 1 : -1;

  switch (a.type) {
    case PROJECT_TYPES.FOUR_OF_A_KIND: {
      const diff = CARD_RANK[a.primaryRank] - CARD_RANK[b.primaryRank];
      if (diff !== 0) return diff > 0 ? 1 : -1;
      return 0;
    }
    case PROJECT_TYPES.THREE_OF_A_KIND: {
      const diff = CARD_RANK[a.primaryRank] - CARD_RANK[b.primaryRank];
      if (diff !== 0) return diff > 0 ? 1 : -1;
      if (a.secondaryRank && b.secondaryRank) {
        const d = CARD_RANK[a.secondaryRank] - CARD_RANK[b.secondaryRank];
        if (d !== 0) return d > 0 ? 1 : -1;
      }
      return 0;
    }
    case PROJECT_TYPES.ONE_PAIR: {
      const diff = CARD_RANK[a.primaryRank] - CARD_RANK[b.primaryRank];
      if (diff !== 0) return diff > 0 ? 1 : -1;
      const len = Math.min(a.secondaryRank.length, b.secondaryRank.length);
      for (let i = 0; i < len; i++) {
        const d = CARD_RANK[a.secondaryRank[i]] - CARD_RANK[b.secondaryRank[i]];
        if (d !== 0) return d > 0 ? 1 : -1;
      }
      return 0;
    }
    case PROJECT_TYPES.TWO_PAIR: {
      const d1 = CARD_RANK[a.primaryRank] - CARD_RANK[b.primaryRank];
      if (d1 !== 0) return d1 > 0 ? 1 : -1;
      const d2 = CARD_RANK[a.secondaryRank] - CARD_RANK[b.secondaryRank];
      if (d2 !== 0) return d2 > 0 ? 1 : -1;
      return 0;
    }
    case PROJECT_TYPES.HIGH_CARD: {
      const aRanks = [...handA].filter(c => c !== 'JOKER').sort((x, y) => CARD_RANK[y] - CARD_RANK[x]);
      const bRanks = [...handB].filter(c => c !== 'JOKER').sort((x, y) => CARD_RANK[y] - CARD_RANK[x]);
      const len = Math.min(aRanks.length, bRanks.length);
      for (let i = 0; i < len; i++) {
        const d = (CARD_RANK[aRanks[i]] || 0) - (CARD_RANK[bRanks[i]] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
      }
      return 0;
    }
    default:
      return 0;
  }
}

/**
 * تحديد الفائز بين اللاعبين المشاركين في المداقشة
 * يرجع { winnerId, isDraw }
 */
function determineWinner(players) {
  if (players.length === 0) return { winnerId: null, isDraw: false };
  if (players.length === 1) return { winnerId: players[0].id, isDraw: false };

  let best = players[0];
  let isDraw = false;

  for (let i = 1; i < players.length; i++) {
    const result = compareHands(best.hand, players[i].hand, best.joker, players[i].joker);
    if (result < 0) {
      best = players[i];
      isDraw = false;
    } else if (result === 0) {
      isDraw = true;
    }
  }

  // تحقق نهائي من عدم تعادل best مع أي مشارك آخر
  if (!isDraw) {
    for (const p of players) {
      if (p.id !== best.id) {
        const r = compareHands(best.hand, p.hand, best.joker, p.joker);
        if (r === 0) { isDraw = true; break; }
      }
    }
  }

  return { winnerId: isDraw ? null : best.id, isDraw };
}

/**
 * اسم المشروع بالعربية
 */
function projectNameAr(hand, hasJoker = false) {
  const h = analyzeHand(hand, hasJoker);
  const names = {
    [PROJECT_TYPES.FOUR_OF_A_KIND]: `رباعي ${CARD_NAMES_AR[h.primaryRank] || h.primaryRank}`,
    [PROJECT_TYPES.THREE_OF_A_KIND]: `ثلاثي ${CARD_NAMES_AR[h.primaryRank] || h.primaryRank}`,
    [PROJECT_TYPES.TWO_PAIR]: `مزدوج ${CARD_NAMES_AR[h.primaryRank] || h.primaryRank} و${CARD_NAMES_AR[h.secondaryRank] || h.secondaryRank}`,
    [PROJECT_TYPES.ONE_PAIR]: `ثنائي ${CARD_NAMES_AR[h.primaryRank] || h.primaryRank}`,
    [PROJECT_TYPES.HIGH_CARD]: `عشوائي`
  };
  return names[h.type] || 'غير معروف';
}

module.exports = {
  buildDeck,
  dealCards,
  randomPerk,
  analyzeHand,
  compareHands,
  determineWinner,
  projectNameAr,
  CARD_NAMES_AR,
  CARD_RANK,
  PROJECT_TYPES,
  PERKS
};
