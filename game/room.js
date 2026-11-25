// =====================================================
// مداقش - إدارة الغرف والجلسات
// =====================================================
'use strict';

const { v4: uuidv4 } = require('uuid');
const engine = require('./engine');

const rooms = new Map(); // roomCode -> Room

/**
 * إنشاء غرفة جديدة
 */
function createRoom(hostSocketId, hostName, settings = {}) {
  const maxPlayers = Math.min(6, Math.max(2, parseInt(settings.maxPlayers, 10) || 4));
  const startBalance = Math.max(1000, parseInt(settings.startBalance, 10) || 10000);
  const reserveBank = Math.max(0, settings.reserveBank !== undefined ? parseInt(settings.reserveBank, 10) : 5000);
  const winAmount = Math.max(1000, parseInt(settings.winAmount, 10) || 100000);

  const code = generateCode();
  const room = {
    code,
    hostId: hostSocketId,
    settings: {
      maxPlayers,
      startBalance,
      reserveBank: Number.isNaN(reserveBank) ? 5000 : reserveBank,
      winAmount
    },
    players: [],     // [{ id, name, balance, reserveBank, reserveUsed, socketId, connected, status, token }]
    state: 'lobby',  // lobby | playing | ended
    round: null,
    roundNumber: 0,
    lastStarterIndex: -1,
    lastStarterId: null,
    result: null
  };

  addPlayer(room, hostSocketId, hostName);
  rooms.set(code, room);
  return room;
}

/**
 * الانضمام إلى غرفة
 */
function joinRoom(code, socketId, playerName) {
  const room = rooms.get(code);
  if (!room) return { error: 'الغرفة غير موجودة' };
  if (room.state !== 'lobby') return { error: 'المباراة قد بدأت بالفعل' };
  if (room.players.length >= room.settings.maxPlayers) return { error: 'الغرفة ممتلئة' };
  if (room.players.find(p => p.name === playerName)) return { error: 'الاسم مستخدم بالفعل في هذه الغرفة' };

  addPlayer(room, socketId, playerName);
  return { room };
}

/**
 * إعادة اتصال لاعب وتحديث معرف السوكيت بشكل آمن
 */
function reconnectPlayer(code, playerName, newSocketId, token = null) {
  const room = rooms.get((code || '').toUpperCase().trim());
  if (!room) return null;

  const player = room.players.find(p => p.name === playerName);
  if (!player) return null;

  // التحقق من التوكن إذا كان مرسلاً لمنع انتحال اللاعبين
  if (token && player.token && player.token !== token) return null;

  const oldId = player.id;
  if (oldId !== newSocketId) {
    updateSocketId(room, oldId, newSocketId);
  } else {
    player.socketId = newSocketId;
  }
  player.connected = true;
  return room;
}

function addPlayer(room, socketId, name) {
  room.players.push({
    id: socketId,
    name,
    balance: room.settings.startBalance,
    reserveBank: room.settings.reserveBank,
    reserveUsed: false,
    socketId,
    connected: true,
    status: 'active', // active | out
    token: uuidv4()
  });
}

/**
 * بدء مباراة جديدة
 */
function startGame(code, hostSocketId) {
  const room = rooms.get(code);
  if (!room) return { error: 'الغرفة غير موجودة' };
  if (room.hostId !== hostSocketId) return { error: 'فقط المضيف يستطيع بدء المباراة' };
  if (room.players.length < 2) return { error: 'يجب أن يكون هناك لاعبان على الأقل' };
  if (room.state !== 'lobby') return { error: 'المباراة بدأت بالفعل' };

  room.state = 'playing';
  startRound(room);
  return { room };
}

/**
 * بدء جولة جديدة
 */
function startRound(room) {
  const activePlayers = getActivePlayers(room);
  if (activePlayers.length < 2) {
    room.state = 'ended';
    if (activePlayers.length === 1) {
      room.result = { winner: activePlayers[0] };
    }
    return;
  }

  room.roundNumber++;

  // تحديد من يبدأ المساومة: الجولة 1 عشوائي، ثم ينتقل للاعب على اليمين
  let starterIndex;
  if (!room.lastStarterId) {
    starterIndex = Math.floor(Math.random() * activePlayers.length);
  } else {
    const prevIdx = activePlayers.findIndex(p => p.id === room.lastStarterId);
    if (prevIdx !== -1) {
      starterIndex = (prevIdx + 1) % activePlayers.length;
    } else {
      starterIndex = (room.lastStarterIndex + 1) % activePlayers.length;
    }
  }
  room.lastStarterIndex = starterIndex;
  room.lastStarterId = activePlayers[starterIndex].id;

  // توزيع 4 أوراق لكل لاعب
  const deck = engine.buildDeck(activePlayers.length);
  const hands = engine.dealCards(activePlayers.map(p => p.id), deck);

  // توزيع البيركات
  const perks = {};
  for (const p of activePlayers) {
    perks[p.id] = engine.randomPerk();
  }

  room.round = {
    phase: 'bidding',       // bidding | boss_offers | reveal | result
    starterIndex,
    currentBidderIndex: starterIndex,
    hands,                  // { playerId: [cards] }
    perks,                  // { playerId: { id, nameAr, descAr } }
    perkFlipped: {},        // { playerId: boolean }
    revealedCards: {},      // { playerId: [revealed cards], playerId_indices: [indices] }
    currentBid: 0,
    bossId: null,
    bossEntry: 0,           // مبلغ دخول البوس
    bids: {},               // { playerId: amount }
    bankEntered: [],        // لاعبون دخلوا بالبنك بأقل من السومة
    foldedPlayers: [],      // لاعبون انسحبوا من المساومة
    offers: {},             // { playerId: { amount, rejections: 0, accepted: false, rejected3times: false } }
    offersAccepted: [],     // [{ playerId, amount }]
    mustReveal: [],         // لاعبون رفضوا العرض 3 مرات (مداقشة إجبارية)
    revealOrder: [],        // [playerId, ...] بالترتيب
    revealTurnIndex: 0,
    result: null
  };

  for (const p of activePlayers) {
    room.round.offers[p.id] = { amount: 0, rejections: 0, accepted: false, rejected3times: false };
    room.round.revealedCards[p.id] = [];
    room.round.revealedCards[p.id + '_indices'] = [];
    room.round.perkFlipped[p.id] = false;
  }

  return room.round;
}

/**
 * قلب كرت البيرك للاعب نفسه
 */
function flipPerk(room, playerId) {
  const round = room.round;
  if (!round || !round.perks[playerId]) return { error: 'لا يوجد بيرك' };
  round.perkFlipped[playerId] = true;
  return { success: true, perk: round.perks[playerId] };
}

// ===================== المساومة =====================

/**
 * تقديم سومة أو رفع السومة
 */
function placeBid(room, playerId, amount) {
  const round = room.round;
  if (!round || round.phase !== 'bidding') return { error: 'ليست مرحلة المساومة' };
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'أدخل مبلغاً صحيحاً' };

  const activePlayers = getActivePlayers(room);
  const curIdx = round.currentBidderIndex % activePlayers.length;
  if (activePlayers[curIdx].id !== playerId) return { error: 'ليس دورك' };
  if (round.foldedPlayers.includes(playerId)) return { error: 'لقد انسحبت من الجولة' };
  if (round.bids[playerId] !== undefined) return { error: 'سبق وساومت، كل لاعب يساوم مرة واحدة فقط' };

  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: 'اللاعب غير موجود' };

  // الحد الأدنى للدخول 1,000 ريال، والزيادة لا تقل عن 1,000 ريال
  if (round.currentBid === 0 && amount < 1000) return { error: 'الحد الأدنى للدخول 1,000 ريال' };
  if (round.currentBid > 0 && amount < round.currentBid + 1000) {
    return { error: `يجب أن تزيد 1,000 ريال على الأقل (الحد الأدنى ${(round.currentBid + 1000).toLocaleString('en-US')})` };
  }

  // لا يُسمح بالدخول بمبلغ أكبر من الرصيد المتاح حالياً (الاحتياطي لا يُستخدم إلا بعد نفاد الأساسي)
  const available = getAvailableBalance(player);
  if (amount > available) return { error: 'رصيدك الأساسي لا يكفي، استخدم زر دخول بالبنك' };

  round.currentBid = amount;
  round.bids[playerId] = amount;
  round.bossId = playerId;

  advanceBidder(room);
  return { success: true };
}

/**
 * دخول اللاعب بالبنك (بمبلغ أقل من السومة، بما في رصيده فقط دون إكمال الفرق)
 */
function enterWithBank(room, playerId) {
  const round = room.round;
  if (!round || round.phase !== 'bidding') return { error: 'ليست مرحلة المساومة' };

  const activePlayers = getActivePlayers(room);
  const curIdx = round.currentBidderIndex % activePlayers.length;
  if (activePlayers[curIdx].id !== playerId) return { error: 'ليس دورك' };
  if (round.foldedPlayers.includes(playerId)) return { error: 'لقد انسحبت من الجولة' };

  if (round.currentBid === 0) return { error: 'ابدأ المساومة بمبلغ 1,000 ريال على الأقل' };

  const player = room.players.find(p => p.id === playerId);
  const available = getAvailableBalance(player);

  if (available <= 0) return { error: 'رصيدك صفر، لا يمكنك الدخول' };
  if (available >= round.currentBid) return { error: 'رصيدك كافٍ، استخدم زر المساومة العادي' };

  round.bids[playerId] = available;
  if (!round.bankEntered.includes(playerId)) {
    round.bankEntered.push(playerId);
  }

  advanceBidder(room);
  return { success: true, amount: available };
}

/**
 * انسحاب اللاعب من المساومة (نهائي)
 */
function foldBid(room, playerId) {
  const round = room.round;
  if (!round || round.phase !== 'bidding') return { error: 'ليست مرحلة المساومة' };

  const activePlayers = getActivePlayers(room);
  const curIdx = round.currentBidderIndex % activePlayers.length;
  if (activePlayers[curIdx].id !== playerId) return { error: 'ليس دورك' };
  if (round.foldedPlayers.includes(playerId)) return { error: 'لقد انسحبت بالفعل' };

  round.foldedPlayers.push(playerId);
  advanceBidder(room);
  return { success: true };
}

/**
 * تقدم المزايد والتحقق من انتهاء المساومة
 * كل لاعب يساوم مرة واحدة فقط (سوّم / دخول بالبنك / انسحاب)
 * بعد ما الكل ياخذ دوره → الأعلى هو البوس
 */
function advanceBidder(room) {
  const round = room.round;
  const activePlayers = getActivePlayers(room);
  const remaining = activePlayers.filter(p => !round.foldedPlayers.includes(p.id));

  // إذا بقي لاعب واحد فقط → هو البوس
  if (remaining.length === 1) {
    round.bossId = remaining[0].id;
    round.bossEntry = round.currentBid || round.bids[remaining[0].id] || 0;
    transitionToBossOffers(room);
    return;
  }

  // تحقق: هل كل اللاعبين أخذوا دورهم؟ (ساوموا أو انسحبوا)
  const allDecided = activePlayers.every(p =>
    round.bids[p.id] !== undefined || round.foldedPlayers.includes(p.id)
  );

  if (allDecided) {
    // الأعلى سومة هو البوس
    if (round.bossId && round.currentBid > 0) {
      round.bossEntry = round.currentBid;
      transitionToBossOffers(room);
    }
    return;
  }

  // ابحث عن اللاعب التالي الذي لم يأخذ دوره بعد
  let next = (round.currentBidderIndex + 1) % activePlayers.length;
  let tries = 0;
  while (
    (round.foldedPlayers.includes(activePlayers[next].id) ||
     round.bids[activePlayers[next].id] !== undefined) &&
    tries < activePlayers.length
  ) {
    next = (next + 1) % activePlayers.length;
    tries++;
  }

  if (tries >= activePlayers.length) {
    // الكل أخذ دوره
    if (round.bossId && round.currentBid > 0) {
      round.bossEntry = round.currentBid;
      transitionToBossOffers(room);
    }
    return;
  }

  round.currentBidderIndex = next;
}

/**
 * الانتقال لمرحلة عروض البوس
 */
function transitionToBossOffers(room) {
  const round = room.round;
  round.phase = 'boss_offers';
  round.bossEntry = round.currentBid || round.bids[round.bossId] || 0;

  const activePlayers = getActivePlayers(room);
  const eligible = activePlayers.filter(p => p.id !== round.bossId && !round.foldedPlayers.includes(p.id));

  if (eligible.length === 0) {
    let bossWin = round.bossEntry;
    if (bossWin > 0 && round.perks[round.bossId]?.id === 'double_win') {
      bossWin *= 2;
    }
    round.phase = 'result';
    round.result = {
      winnerId: round.bossId,
      isDraw: false,
      noContest: true,
      bossId: round.bossId,
      bossEntry: round.bossEntry,
      totalOffers: 0,
      remaining: round.bossEntry,
      payments: bossWin > 0
        ? [{ playerId: round.bossId, change: bossWin, reason: 'فوز البوس (انسحاب البقية)' }]
        : []
    };
    if (bossWin > 0) {
      applyPayments(room);
    }
  }
}

// ===================== عروض البوس =====================

/**
 * البوس يقدم عرضاً للاعب معين
 */
function makeOffer(room, bossId, targetPlayerId, amount) {
  const round = room.round;
  if (!round || round.phase !== 'boss_offers') return { error: 'ليست مرحلة عروض الانسحاب' };
  if (round.bossId !== bossId) return { error: 'فقط البوس يستطيع تقديم عروض' };
  if (bossId === targetPlayerId) return { error: 'لا تستطيع تقديم عرض لنفسك' };
  if (round.foldedPlayers.includes(targetPlayerId)) return { error: 'هذا اللاعب منسحب بالفعل' };
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'المبلغ يجب أن يكون عدداً صحيحاً أكبر من صفر' };

  const offer = round.offers[targetPlayerId];
  if (!offer) return { error: 'اللاعب غير موجود' };
  if (offer.accepted) return { error: 'وافق هذا اللاعب بالفعل' };
  if (offer.rejected3times) return { error: 'هذا اللاعب رفض 3 مرات، المداقشة إجبارية' };

  const acceptedTotal = round.offersAccepted.reduce((s, o) => s + o.amount, 0);
  if (amount >= round.bossEntry) return { error: 'العرض يجب أن يكون أقل من مبلغ دخول البوس' };
  if (acceptedTotal + amount > round.bossEntry) {
    return { error: `مجموع العروض لا يمكن أن يتجاوز المتبقي من دخول البوس (${round.bossEntry - acceptedTotal} ريال)` };
  }

  offer.amount = amount;
  return { success: true };
}

/**
 * اللاعب يقبل عرض البوس
 */
function acceptOffer(room, playerId) {
  const round = room.round;
  if (!round || round.phase !== 'boss_offers') return { error: 'ليست مرحلة عروض الانسحاب' };

  const offer = round.offers[playerId];
  if (!offer || offer.amount === 0) return { error: 'لا يوجد عرض مقدم لك حالياً' };
  if (offer.accepted) return { error: 'وافقت بالفعل' };
  if (offer.rejected3times) return { error: 'انتهت صلاحية العروض، المداقشة إجبارية' };

  const acceptedTotal = round.offersAccepted.reduce((s, o) => s + o.amount, 0);
  if (acceptedTotal + offer.amount > round.bossEntry) {
    offer.amount = 0;
    return { error: 'العرض انتهت صلاحيته لعدم كفاية المتبقي من دخول البوس' };
  }

  offer.accepted = true;
  round.offersAccepted.push({ playerId, amount: offer.amount });

  checkBossOffersComplete(room);
  return { success: true };
}

/**
 * اللاعب يرفض عرض البوس
 */
function rejectOffer(room, playerId) {
  const round = room.round;
  if (!round || round.phase !== 'boss_offers') return { error: 'ليست مرحلة عروض الانسحاب' };

  const offer = round.offers[playerId];
  if (!offer || offer.amount === 0) return { error: 'لا يوجد عرض مقدم لك حالياً' };
  if (offer.accepted) return { error: 'وافقت بالفعل' };
  if (offer.rejected3times) return { error: 'وصلت للحد الأقصى للرفض' };

  offer.rejections++;
  offer.amount = 0;

  if (offer.rejections >= 3) {
    offer.rejected3times = true;
    round.mustReveal.push(playerId);
  }

  checkBossOffersComplete(room);
  return { success: true, rejections: offer.rejections };
}

/**
 * التحقق من انتهاء مرحلة عروض الانسحاب
 * لا ينتقل للمداقشة إلا بعد انتهاء البوس من التعامل مع جميع اللاعبين المؤهلين
 */
function checkBossOffersComplete(room) {
  const round = room.round;
  const activePlayers = getActivePlayers(room);
  const eligible = activePlayers.filter(p => p.id !== round.bossId && !round.foldedPlayers.includes(p.id));

  const allDecided = eligible.every(p => {
    const offer = round.offers[p.id];
    return offer.accepted || offer.rejected3times;
  });

  if (allDecided) {
    if (round.mustReveal.length === 0) {
      finishRoundNoBoss(room);
    } else {
      startRevealPhase(room);
    }
  }
}

/**
 * البوس يبدأ المداقشة يدوياً (فقط بعد حسم جميع اللاعبين المؤهلين)
 */
function bossStartReveal(room, bossId) {
  const round = room.round;
  if (!round || round.phase !== 'boss_offers') return { error: 'ليست مرحلة العروض' };
  if (round.bossId !== bossId) return { error: 'فقط البوس يمكنه البدء' };
  if (round.mustReveal.length === 0) return { error: 'لا يوجد لاعبون للمداقشة' };

  const activePlayers = getActivePlayers(room);
  const eligible = activePlayers.filter(p => p.id !== round.bossId && !round.foldedPlayers.includes(p.id));
  const pending = eligible.filter(p => {
    const offer = round.offers[p.id];
    return !offer.accepted && !offer.rejected3times;
  });
  if (pending.length > 0) {
    return { error: 'أكمل التعامل مع بقية اللاعبين أولاً قبل بدء المداقشة' };
  }

  startRevealPhase(room);
  return { success: true };
}

// ===================== مرحلة الكشف =====================

function startRevealPhase(room) {
  const round = room.round;
  round.phase = 'reveal';
  round.revealOrder = [round.bossId, ...round.mustReveal];
  round.revealTurnIndex = 0;
}

/**
 * اللاعب يكشف ورقة واحدة من أوراقه بالتناوب
 */
function revealCard(room, playerId, cardIndex) {
  const round = room.round;
  if (!round || round.phase !== 'reveal') return { error: 'ليست مرحلة الكشف' };

  const currentTurnPlayer = round.revealOrder[round.revealTurnIndex % round.revealOrder.length];
  if (currentTurnPlayer !== playerId) return { error: 'ليس دورك في الكشف' };

  const hand = round.hands[playerId];
  if (!hand) return { error: 'لا توجد أوراق' };
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= hand.length) {
    return { error: 'مؤشر الورقة غير صحيح' };
  }

  const revealed = round.revealedCards[playerId] || [];
  if (revealed.length >= hand.length) return { error: 'كشفت جميع أوراقك بالفعل' };

  const alreadyRevealed = round.revealedCards[playerId + '_indices'] || [];
  if (alreadyRevealed.includes(cardIndex)) return { error: 'هذه الورقة مكشوفة بالفعل' };

  if (!round.revealedCards[playerId]) round.revealedCards[playerId] = [];
  if (!round.revealedCards[playerId + '_indices']) round.revealedCards[playerId + '_indices'] = [];

  round.revealedCards[playerId + '_indices'].push(cardIndex);
  round.revealedCards[playerId].push(hand[cardIndex]);

  round.revealTurnIndex++;

  const allRevealed = round.revealOrder.every(pid => {
    const rCount = (round.revealedCards[pid] || []).length;
    return rCount >= round.hands[pid].length;
  });

  if (allRevealed) {
    resolveRound(room);
  }

  return { success: true, card: hand[cardIndex] };
}

// ===================== حل الجولة =====================

function resolveRound(room) {
  const round = room.round;
  const participants = round.revealOrder;

  const competing = participants.map(pid => ({
    id: pid,
    hand: round.hands[pid],
    joker: round.perks[pid]?.id === 'joker'
  }));

  const { winnerId, isDraw } = engine.determineWinner(competing);

  const bossEntry = round.bossEntry;
  const totalOffers = round.offersAccepted.reduce((sum, o) => sum + o.amount, 0);
  const remaining = Math.max(0, bossEntry - totalOffers);

  round.phase = 'result';
  round.result = {
    winnerId,
    isDraw,
    bossId: round.bossId,
    bossEntry,
    totalOffers,
    remaining,
    projects: Object.fromEntries(
      participants.map(pid => [
        pid,
        engine.projectNameAr(round.hands[pid], round.perks[pid]?.id === 'joker')
      ])
    ),
    payments: []
  };

  if (isDraw) {
    // تعادل كامل: كل لاعب يسترجع دخله ولا أحد يفوز بمبلغ الفوز
    // العروض المقبولة مسبقاً يحصل عليها من وافقوا من دخول البوس
    for (const o of round.offersAccepted) {
      round.result.payments.push({ playerId: o.playerId, change: o.amount, reason: 'عرض انسحاب مقبول' });
    }
    if (totalOffers > 0) {
      round.result.payments.push({ playerId: round.bossId, change: -totalOffers, reason: 'عروض انسحاب مقبولة (تعادل)' });
    } else {
      round.result.payments.push({ playerId: round.bossId, change: 0, reason: 'تعادل - استرداد' });
    }
  } else if (winnerId === round.bossId) {
    // البوس فاز بالمداقشة: يفوز بالمبلغ المتبقي بعد خصم العروض المقبولة
    let bossWin = remaining;
    if (round.perks[round.bossId]?.id === 'double_win') {
      bossWin *= 2;
    }
    round.result.payments.push({ playerId: round.bossId, change: bossWin, reason: 'فوز البوس بالمداقشة' });
    for (const o of round.offersAccepted) {
      round.result.payments.push({ playerId: o.playerId, change: o.amount, reason: 'عرض انسحاب مقبول' });
    }
  } else {
    // لاعب آخر فاز على البوس:
    // الفائز يحصل على المتبقي من دخول البوس بعد خصم العروض (يتضاعف مع بيرك مضاعفة المكسب)
    // المقبولون يحصلون على عروضهم، والبوس يخسر مبلغ دخوله الإجمالي (نصفه مع بيرك نصف الخسارة)
    let winAmount = remaining;
    if (round.perks[winnerId]?.id === 'double_win') {
      winAmount *= 2;
    }

    let bossLoss = bossEntry;
    if (round.perks[round.bossId]?.id === 'half_loss') {
      bossLoss = Math.floor(bossEntry / 2);
    }

    for (const o of round.offersAccepted) {
      round.result.payments.push({ playerId: o.playerId, change: o.amount, reason: 'عرض انسحاب مقبول' });
    }
    round.result.payments.push({ playerId: winnerId, change: winAmount, reason: 'فوز المداقشة' });
    round.result.payments.push({ playerId: round.bossId, change: -bossLoss, reason: 'خسارة البوس' });
  }

  applyPayments(room);
}

/**
 * انتهاء الجولة بدون مداقشة (وافق جميع اللاعبين على عروض البوس)
 */
function finishRoundNoBoss(room) {
  const round = room.round;
  const totalOffers = round.offersAccepted.reduce((sum, o) => sum + o.amount, 0);
  const remaining = Math.max(0, round.bossEntry - totalOffers);

  round.phase = 'result';
  round.result = {
    winnerId: round.bossId,
    isDraw: false,
    bossId: round.bossId,
    bossEntry: round.bossEntry,
    totalOffers,
    remaining,
    noContest: true,
    payments: []
  };

  for (const o of round.offersAccepted) {
    round.result.payments.push({ playerId: o.playerId, change: o.amount, reason: 'عرض انسحاب مقبول' });
  }

  let bossWin = remaining;
  if (round.perks[round.bossId]?.id === 'double_win') {
    bossWin *= 2;
  }
  round.result.payments.push({ playerId: round.bossId, change: bossWin, reason: 'فوز البوس بلا مداقشة' });

  applyPayments(room);
}

/**
 * تطبيق المدفوعات وتفعيل البنك الاحتياطي عند وصول الرصيد الأساسي إلى صفر
 */
function applyPayments(room) {
  const round = room.round;
  const netChanges = new Map();

  for (const payment of round.result.payments) {
    netChanges.set(payment.playerId, (netChanges.get(payment.playerId) || 0) + payment.change);
  }

  const reserveNotes = [];
  for (const [playerId, netChange] of netChanges.entries()) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) continue;

    player.balance += netChange;

    // إذا نفد الرصيد الأساسي (وصل لصفر أو أقل) ولم يُستخدم الاحتياطي بعد
    if (player.balance <= 0) {
      if (!player.reserveUsed && player.reserveBank > 0) {
        player.balance = Math.max(0, player.balance) + player.reserveBank;
        player.reserveUsed = true;
        reserveNotes.push({ playerId: player.id, change: 0, reason: 'تم تفعيل البنك الاحتياطي' });
      } else {
        player.balance = 0;
        player.status = 'out';
      }
    }
  }

  round.result.payments.push(...reserveNotes);

  // تحقق من فوز أحد اللاعبين بالوصول إلى مبلغ الفوز المحدد
  const qualifiers = room.players
    .filter(p => p.balance >= room.settings.winAmount)
    .sort((a, b) => b.balance - a.balance);

  if (qualifiers.length > 0) {
    room.state = 'ended';
    room.result = { winner: qualifiers[0] };
    return;
  }

  // أو إذا خرج جميع اللاعبين ما عدا لاعباً واحداً
  const activePlayers = getActivePlayers(room);
  if (activePlayers.length === 1) {
    room.state = 'ended';
    room.result = { winner: activePlayers[0] };
  }
}

// ===================== مساعدات =====================

function getActivePlayers(room) {
  return room.players.filter(p => p.status === 'active');
}

/**
 * الرصيد المتاح حالياً: الرصيد الأساسي فقط (الاحتياطي لا يُفتح إلا عند نفاد الأساسي)
 */
function getAvailableBalance(player) {
  return player.balance;
}

function getRoom(code) {
  return rooms.get(code);
}

function getRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (room.players.find(p => p.socketId === socketId)) return room;
  }
  return null;
}

function updateSocketId(room, oldId, newId) {
  const player = room.players.find(p => p.id === oldId || p.socketId === oldId);
  if (!player) return;

  player.socketId = newId;
  player.id = newId;
  if (room.hostId === oldId) room.hostId = newId;
  if (room.lastStarterId === oldId) room.lastStarterId = newId;

  if (room.round) {
    const round = room.round;
    if (round.hands[oldId]) { round.hands[newId] = round.hands[oldId]; delete round.hands[oldId]; }
    if (round.perks[oldId]) { round.perks[newId] = round.perks[oldId]; delete round.perks[oldId]; }
    if (round.perkFlipped && oldId in round.perkFlipped) {
      round.perkFlipped[newId] = round.perkFlipped[oldId];
      delete round.perkFlipped[oldId];
    }
    if (round.bossId === oldId) round.bossId = newId;

    const replaceInArr = (arr) => {
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === oldId) arr[i] = newId;
      }
    };
    replaceInArr(round.foldedPlayers);
    replaceInArr(round.bankEntered);
    replaceInArr(round.mustReveal);
    replaceInArr(round.revealOrder);

    if (round.bids[oldId] !== undefined) { round.bids[newId] = round.bids[oldId]; delete round.bids[oldId]; }
    if (round.offers[oldId]) { round.offers[newId] = round.offers[oldId]; delete round.offers[oldId]; }
    for (const o of round.offersAccepted) {
      if (o.playerId === oldId) o.playerId = newId;
    }

    if (round.revealedCards[oldId]) {
      round.revealedCards[newId] = round.revealedCards[oldId];
      delete round.revealedCards[oldId];
    }
    if (round.revealedCards[oldId + '_indices']) {
      round.revealedCards[newId + '_indices'] = round.revealedCards[oldId + '_indices'];
      delete round.revealedCards[oldId + '_indices'];
    }

    if (round.result) {
      if (round.result.winnerId === oldId) round.result.winnerId = newId;
      if (round.result.bossId === oldId) round.result.bossId = newId;
      if (round.result.projects && round.result.projects[oldId]) {
        round.result.projects[newId] = round.result.projects[oldId];
        delete round.result.projects[oldId];
      }
      for (const p of round.result.payments || []) {
        if (p.playerId === oldId) p.playerId = newId;
      }
    }
  }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/**
 * بناء حالة اللعبة المرئية للاعب واحد فقط (تخفي أوراق وبيركات وعروض الآخرين)
 */
function buildStateForPlayer(room, playerId) {
  const round = room.round;
  const me = room.players.find(p => p.id === playerId);
  const state = {
    code: room.code,
    settings: room.settings,
    state: room.state,
    roundNumber: room.roundNumber,
    myId: playerId,
    myToken: me ? me.token : null,
    result: room.result ? {
      winner: room.result.winner ? {
        id: room.result.winner.id,
        name: room.result.winner.name,
        balance: room.result.winner.balance
      } : null
    } : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      balance: (room.state === 'ended' || p.id === playerId) ? p.balance : null,
      reserveBank: (room.state === 'ended' || p.id === playerId) ? p.reserveBank : null,
      reserveUsed: p.reserveUsed,
      connected: p.connected,
      status: p.status,
      isHost: p.id === room.hostId
    })),
    isHost: room.hostId === playerId
  };

  if (round) {
    state.round = {
      phase: round.phase,
      currentBid: round.currentBid,
      bossId: round.bossId,
      bossEntry: round.bossEntry,
      foldedPlayers: round.foldedPlayers,
      bankEntered: round.bankEntered,
      mustReveal: round.mustReveal,
      offersAccepted: round.offersAccepted.map(o => ({ playerId: o.playerId })), // إخفاء مبلغ العرض المقبول عن بقية اللاعبين حتى النتيجة
      revealOrder: round.revealOrder,
      revealTurnIndex: round.revealTurnIndex,
      result: round.result,
      // أوراق اللاعب نفسه وبيركه فقط
      myHand: round.hands[playerId] || [],
      myPerk: round.perks[playerId] || null,
      myPerkFlipped: Boolean(round.perkFlipped && round.perkFlipped[playerId]),
      myRevealedIndices: round.revealedCards[playerId + '_indices'] || [],
      // الأوراق المكشوفة للمشاركين فقط في مرحلة المداقشة والنتيجة
      revealedCards: (round.phase === 'reveal' || round.phase === 'result')
        ? Object.fromEntries(
            Object.entries(round.revealedCards)
              .filter(([k]) => !k.endsWith('_indices') && round.revealOrder.includes(k))
              .map(([k, v]) => {
                if (round.phase === 'result' && round.revealOrder.includes(k)) {
                  return [k, round.hands[k] || v];
                }
                return [k, v];
              })
          )
        : {},
      // العرض الخاص باللاعب نفسه فقط
      myOffer: round.offers[playerId] ? {
        amount: round.offers[playerId].amount,
        rejections: round.offers[playerId].rejections,
        accepted: round.offers[playerId].accepted,
        rejected3times: round.offers[playerId].rejected3times
      } : null,
      currentBidderIndex: round.currentBidderIndex,
      bids: round.bids,
      starterIndex: round.starterIndex
    };

    // البوس يرى العروض التي أرسلها وحالاتها فقط (دون أوراق اللاعبين)
    if (round.bossId === playerId) {
      state.round.sentOffers = {};
      for (const [pid, offer] of Object.entries(round.offers)) {
        state.round.sentOffers[pid] = {
          amount: offer.amount,
          rejections: offer.rejections,
          accepted: offer.accepted,
          rejected3times: offer.rejected3times
        };
      }
    }
  }

  return state;
}

module.exports = {
  createRoom,
  joinRoom,
  reconnectPlayer,
  startGame,
  startRound,
  flipPerk,
  placeBid,
  enterWithBank,
  foldBid,
  makeOffer,
  acceptOffer,
  rejectOffer,
  bossStartReveal,
  revealCard,
  getRoom,
  getRoomBySocketId,
  updateSocketId,
  buildStateForPlayer,
  getActivePlayers
};
