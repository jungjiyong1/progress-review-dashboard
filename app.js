(function (global) {
  "use strict";

  const COURSE = global.COURSE_INTEGRATED_SCIENCE_1;
  const STORE_KEY = "integratedScienceProgressReviewDashboard.v1";
  const UI_VERSION = "sections-v1";
  const DEFAULT_SELECTED_UNITS = [6, 7, 8, 9, 10, 11, 12, 15, 16, 19, 20, 23, 24];
  const DIFFICULTY_WEIGHT = { D1: 1, D2: 2, D3: 3 };
  const REVIEW_MODES = {
    full: {
      label: "전체",
      maxProgressReviews: 99,
      maxExamPrepReviews: 99,
      rounds: { D3: [1, 2, 3, 4, 5, 6], D2: [1, 2, 3, 4, 5], D1: [1, 2, 3, 4] },
    },
  };
  const REVIEW_SCHEDULE = {
    D3: [
      { offset: 0, type: "wanja" },
      { offset: 1, type: "gichul" },
      { offset: 4, type: "selpa" },
      { offset: 7, type: "examPrep" },
      { offset: 11, type: "examPrep" },
    ],
    D2: [
      { offset: 0, type: "wanja" },
      { offset: 1, type: "gichul" },
      { offset: 4, type: "selpa" },
      { offset: 7, type: "examPrep" },
      { offset: 11, type: "examPrep" },
    ],
    D1: [
      { offset: 0, type: "wanja" },
      { offset: 1, type: "gichul" },
      { offset: 4, type: "selpa" },
      { offset: 11, type: "examPrep" },
    ],
  };

  let state = createDefaultState();

  function createDefaultState() {
    return {
      uiVersion: UI_VERSION,
      tab: "dashboard",
      selectedSectionId: null,
      sections: [],
      draft: {
        name: "",
        totalWeeks: 8,
        prepWeeks: 2,
        currentWeek: 1,
        reviewMode: "full",
        selectedUnitIds: DEFAULT_SELECTED_UNITS.slice(),
      },
    };
  }

  function unitById(course, id) {
    return course.units.find((unit) => unit.id === Number(id));
  }

  function groupById(course, id) {
    return course.groups.find((group) => group.id === id);
  }

  function scoreDifficulty(difficulty) {
    return DIFFICULTY_WEIGHT[difficulty] || 0;
  }

  function uniqNumbers(values) {
    return Array.from(new Set((values || []).map(Number).filter((value) => Number.isInteger(value)))).sort((a, b) => a - b);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function resolveReviewMode(mode) {
    return REVIEW_MODES[mode] || REVIEW_MODES.full;
  }

  function formatUnit(unit) {
    return `${unit.code} ${unit.name}`;
  }

  function slimUnit(unit) {
    return {
      id: unit.id,
      code: unit.code,
      name: unit.name,
      difficulty: unit.difficulty,
      groupId: unit.groupId,
      memo: unit.memo,
      wanjaHomework: unit.wanjaHomework || null,
    };
  }

  function createId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function manualAnchorIds(manualAnchors) {
    return uniqNumbers(Object.values(manualAnchors || {}).flat());
  }

  function normalizeManualAnchors(manualAnchors) {
    const result = {};
    Object.entries(manualAnchors || {}).forEach(([week, ids]) => {
      const weekNumber = Number(week);
      const unitIds = uniqNumbers(ids).filter((id) => unitById(COURSE, id));
      if (Number.isInteger(weekNumber) && unitIds.length > 0) {
        result[String(weekNumber)] = unitIds;
      }
    });
    return result;
  }

  function normalizeSettings(settings) {
    const totalWeeks = clamp(Number(settings?.totalWeeks) || 8, 3, 20);
    const prepWeeks = clamp(Number(settings?.prepWeeks) || 2, 1, totalWeeks - 1);
    return {
      totalWeeks,
      prepWeeks,
      currentWeek: clamp(Number(settings?.currentWeek) || 1, 1, totalWeeks),
      reviewMode: "full",
      selectedUnitIds: uniqNumbers(settings?.selectedUnitIds || DEFAULT_SELECTED_UNITS).filter((id) => unitById(COURSE, id)),
    };
  }

  function selectedSection() {
    return state.sections.find((section) => section.id === state.selectedSectionId) || state.sections[0] || null;
  }

  function buildSelectedGroups(course, selectedUnitIds) {
    const selectedSet = new Set(selectedUnitIds);
    return course.groups
      .map((group) => {
        const unitIds = group.unitIds.filter((id) => selectedSet.has(id));
        const units = unitIds.map((id) => unitById(course, id)).filter(Boolean);
        const hardestUnit = units.reduce((hardest, unit) => {
          if (!hardest) return unit;
          return scoreDifficulty(unit.difficulty) > scoreDifficulty(hardest.difficulty) ? unit : hardest;
        }, null);

        return {
          id: group.id,
          name: group.name,
          unitIds,
          units,
          difficulty: hardestUnit ? hardestUnit.difficulty : group.difficulty,
          fixedDifficulty: group.difficulty,
          firstWeekCandidate: group.firstWeekCandidate,
          memo: group.memo,
        };
      })
      .filter((group) => group.unitIds.length > 0);
  }

  function selectedGroupMap(groups) {
    const map = new Map();
    groups.forEach((group) => {
      group.unitIds.forEach((id) => map.set(id, group.id));
    });
    return map;
  }

  function groupHasUnmetStrongPrereq(group, selectedSet, scheduledGroupIds, unitToGroup) {
    return group.units.some((unit) =>
      unit.prerequisites.some((pre) => {
        if (pre.strength !== "strong" || !selectedSet.has(pre.id)) return false;
        const prereqGroupId = unitToGroup.get(pre.id);
        return prereqGroupId && prereqGroupId !== group.id && !scheduledGroupIds.has(prereqGroupId);
      }),
    );
  }

  function groupSupportsRemainingHardGroup(candidate, remainingGroups) {
    const candidateUnits = new Set(candidate.unitIds);
    return remainingGroups.some((group) => {
      if (group.id === candidate.id || scoreDifficulty(group.difficulty) < 3) return false;
      return group.units.some((unit) => unit.prerequisites.some((pre) => candidateUnits.has(pre.id)));
    });
  }

  function sortGroupsForPick(groups) {
    return groups.slice().sort((a, b) => {
      const firstCandidate = (b.firstWeekCandidate === "yes") - (a.firstWeekCandidate === "yes");
      if (firstCandidate) return firstCandidate;
      const difficulty = scoreDifficulty(b.difficulty) - scoreDifficulty(a.difficulty);
      if (difficulty) return difficulty;
      return Math.min(...a.unitIds) - Math.min(...b.unitIds);
    });
  }

  function sortGroupsForBuffer(groups, remainingGroups) {
    return groups.slice().sort((a, b) => {
      const aBridge = groupSupportsRemainingHardGroup(a, remainingGroups) ? 1 : 0;
      const bBridge = groupSupportsRemainingHardGroup(b, remainingGroups) ? 1 : 0;
      if (bBridge !== aBridge) return bBridge - aBridge;
      const difficulty = scoreDifficulty(a.difficulty) - scoreDifficulty(b.difficulty);
      if (difficulty) return difficulty;
      return Math.min(...a.unitIds) - Math.min(...b.unitIds);
    });
  }

  function orderGroups(course, groups, selectedUnitIds) {
    const selectedSet = new Set(selectedUnitIds);
    const unitToGroup = selectedGroupMap(groups);
    const scheduledGroupIds = new Set();
    const remaining = groups.slice();
    const ordered = [];

    while (remaining.length > 0) {
      const slot = ordered.length + 1;
      let available = remaining.filter((group) =>
        !groupHasUnmetStrongPrereq(group, selectedSet, scheduledGroupIds, unitToGroup),
      );

      if (available.length === 0) {
        available = remaining.slice();
      }

      let picked;
      if (slot === 1) {
        picked =
          sortGroupsForPick(available).find((group) => group.firstWeekCandidate === "yes" && scoreDifficulty(group.difficulty) >= 3) ||
          sortGroupsForPick(available).find((group) => scoreDifficulty(group.difficulty) >= 3 && group.firstWeekCandidate !== "no") ||
          sortGroupsForPick(available)[0];
      } else if (slot % 2 === 0) {
        picked = sortGroupsForBuffer(available, remaining)[0];
      } else {
        picked = sortGroupsForPick(available)[0];
      }

      ordered.push(picked);
      scheduledGroupIds.add(picked.id);
      remaining.splice(remaining.findIndex((group) => group.id === picked.id), 1);
    }

    return ordered;
  }

  function progressRole(week) {
    if (week === 1) return "독립 최고난도 진도";
    if (week === 2) return "완충 + 선행 브리지";
    if (week === 3) return "다음 고난도 진도";
    if (week % 2 === 0) return "완충 + 회수";
    return "중상 난이도 진도";
  }

  function createWeeks(totalWeeks, prepWeeks) {
    const progressWeeks = totalWeeks - prepWeeks;
    return Array.from({ length: totalWeeks }, (_, index) => {
      const week = index + 1;
      const isPrep = week > progressWeeks;
      const prepIndex = week - progressWeeks;
      return {
        week,
        type: isPrep ? "examPrep" : "progress",
        role: isPrep
          ? prepIndex === 1
            ? "시험대비 1: 약점 진단 + 단원별 회수"
            : "시험대비 2: 실전 모의 + 오답 + 최종 암기"
          : progressRole(week),
        manualAnchor: false,
        progressGroups: [],
        progressUnits: [],
        reviewEvents: [],
        examPrepMaterials: [],
      };
    });
  }

  function pushProgressGroup(week, group) {
    if (!week.progressGroups.some((entry) => entry.id === group.id)) {
      week.progressGroups.push({
        id: group.id,
        name: group.name,
        difficulty: group.difficulty,
        unitIds: group.unitIds.slice(),
        memo: group.memo,
      });
    }
  }

  function pushProgressUnit(week, unit) {
    if (!week.progressUnits.some((entry) => entry.id === unit.id)) {
      week.progressUnits.push(slimUnit(unit));
    }
  }

  function applyManualAnchors(course, weeks, manualAnchors, progressWeeks) {
    const anchoredIds = new Set();
    Object.entries(manualAnchors || {}).forEach(([weekKey, unitIds]) => {
      const weekNumber = Number(weekKey);
      if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > progressWeeks) return;
      const week = weeks[weekNumber - 1];
      week.manualAnchor = true;

      uniqNumbers(unitIds).forEach((unitId) => {
        const unit = unitById(course, unitId);
        if (!unit) return;
        const group = groupById(course, unit.groupId);
        if (group) {
          pushProgressGroup(week, {
            ...group,
            units: [unit],
            unitIds: [unit.id],
            difficulty: unit.difficulty,
          });
        }
        pushProgressUnit(week, unit);
        anchoredIds.add(unit.id);
      });
    });
    return anchoredIds;
  }

  function assignGroupsToWeeks(orderedGroups, weeks, progressWeeks, availableWeekNumbers) {
    if (orderedGroups.length === 0) return;
    const slots = availableWeekNumbers.length ? availableWeekNumbers : Array.from({ length: progressWeeks }, (_, index) => index + 1);

    orderedGroups.forEach((group, index) => {
      const slotIndex = orderedGroups.length <= slots.length
        ? index
        : Math.min(slots.length - 1, Math.ceil(((index + 1) * slots.length) / orderedGroups.length) - 1);
      const week = weeks[slots[slotIndex] - 1];
      pushProgressGroup(week, group);
      group.units.forEach((unit) => pushProgressUnit(week, unit));
    });
  }

  function findWanjaFinishResources(course, unitId) {
    return course.wanjaFinish.filter((resource) => resource.unitIds.includes(unitId));
  }

  function reviewTypeForRound(round, reviewType) {
    if (reviewType) return reviewType;
    if (round === 1) return "wanja";
    if (round === 2) return "gichul";
    if (round === 3) return "selpa";
    return "examPrep";
  }

  function materialForReview(course, unit, round, reviewWeek, progressWeeks, reviewType) {
    const type = reviewTypeForRound(round, reviewType);
    if (type === "examPrep") {
      return {
        label: reviewWeek > progressWeeks ? `시험대비 회수 (원래 ${round}차)` : `${round}차 복습`,
        materialName: "실전대비북 + 완자 마무리",
        studentLabel: "프린트 자료 + 완자 마무리",
        homeworkMessage: "",
        items: [
          {
            book: "실전대비북",
            folder: course.folders.examPrep,
            file: unit.resources.examPrep,
            detail: "프린트 자료",
          },
          ...findWanjaFinishResources(course, unit.id).map((resource) => ({
            book: "완자 마무리",
            folder: course.folders.wanja,
            file: resource.file,
            detail: resource.name,
          })),
        ],
      };
    }

    if (type === "wanja") {
      return {
        label: "1차 복습",
        materialName: "완자 내신만점 문제 + 실력 UP",
        studentLabel: unit.wanjaHomework?.message || `완자 ${unit.code}강 내신만점/실력 UP`,
        homeworkMessage: unit.wanjaHomework?.message || `완자 ${unit.code}강 내신만점/실력 UP`,
        items: [
          {
            book: "완자",
            folder: course.folders.wanja,
            file: unit.resources.wanja,
            detail: unit.wanjaHomework?.label || "내신만점 문제와 실력 UP",
          },
        ],
      };
    }

    if (type === "gichul") {
      return {
        label: "2차 복습",
        materialName: "기출픽",
        studentLabel: "기출픽 프린트 자료",
        homeworkMessage: "",
        items: [
          {
            book: "기출픽",
            folder: course.folders.gichul,
            file: unit.resources.gichul,
            detail: "프린트 자료",
          },
        ],
      };
    }

    return {
      label: `${round}차 복습`,
      materialName: "셀파",
      studentLabel: "셀파 프린트 자료",
      homeworkMessage: "",
      items: [
        {
          book: "셀파",
          folder: course.folders.selpa,
          file: unit.resources.selpa,
          detail: "프린트 자료",
        },
      ],
    };
  }

  function reviewPriority(event) {
    return (event.round === 1 ? 10000 : 0)
      + scoreDifficulty(event.difficulty) * 1000
      - event.round * 100
      + event.anchorWeek;
  }

  function reviewBundleKey(event) {
    return `${event.anchorWeek}-${event.round}-${event.groupId || event.unitId}-${event.materialName}`;
  }

  function reviewBundlePriority(events) {
    return events.reduce((best, event) => Math.max(best, reviewPriority(event)), 0);
  }

  function trimWeeklyReviewLoad(weeks, reviewMode) {
    weeks.forEach((week) => {
      const limit = week.type === "examPrep" ? reviewMode.maxExamPrepReviews : reviewMode.maxProgressReviews;
      const bundles = new Map();
      week.reviewEvents.forEach((event) => {
        const key = reviewBundleKey(event);
        if (!bundles.has(key)) bundles.set(key, []);
        bundles.get(key).push(event);
      });

      if (bundles.size <= limit) return;

      const sorted = Array.from(bundles.entries())
        .map(([key, events], index) => ({ key, events, index }))
        .sort((a, b) => reviewBundlePriority(b.events) - reviewBundlePriority(a.events) || a.index - b.index);
      const keep = new Set(sorted.slice(0, limit).map((entry) => entry.key));

      week.reviewEvents.forEach((event) => {
        if (keep.has(reviewBundleKey(event))) return;
        event.skipped = true;
        event.autoTrimmed = true;
        event.trimReason = `주차별 복습 묶음 상한(${limit}개)을 넘어 자동 제외`;
      });
    });
  }

  function addReviewEvents(course, weeks, totalWeeks, prepWeeks, reviewMode) {
    const progressWeeks = totalWeeks - prepWeeks;
    const progressAnchors = [];

    weeks.forEach((week) => {
      if (week.type !== "progress") return;
      week.progressUnits.forEach((progressUnit) => {
        const unit = unitById(course, progressUnit.id);
        if (!unit) return;
        progressAnchors.push({ unit, anchorWeek: week.week });
      });
    });

    progressAnchors.forEach(({ unit, anchorWeek }) => {
      const schedule = REVIEW_SCHEDULE[unit.difficulty] || REVIEW_SCHEDULE.D2;
      schedule.forEach((step, index) => {
        const interval = step.offset;
        const reviewWeek = anchorWeek + interval;
        if (reviewWeek > totalWeeks) return;
        const round = index + 1;
        if (!reviewMode.rounds[unit.difficulty]?.includes(round)) return;
        const material = materialForReview(course, unit, round, reviewWeek, progressWeeks, step.type);
        weeks[reviewWeek - 1].reviewEvents.push({
          id: `U${unit.code}-A${anchorWeek}-R${round}-W${reviewWeek}`,
          unitId: unit.id,
          unitCode: unit.code,
          unitName: unit.name,
          groupId: unit.groupId,
          difficulty: unit.difficulty,
          reviewType: step.type,
          anchorWeek,
          reviewWeek,
          interval,
          round,
          label: material.label,
          materialName: material.materialName,
          studentLabel: material.studentLabel,
          homeworkMessage: material.homeworkMessage,
          materials: material.items,
          skipped: false,
          autoTrimmed: false,
          trimReason: "",
        });
      });
    });

    trimWeeklyReviewLoad(weeks, reviewMode);
  }

  function addExamPrepMaterials(course, weeks, selectedUnitIds, totalWeeks, prepWeeks) {
    const progressWeeks = totalWeeks - prepWeeks;
    weeks
      .filter((week) => week.type === "examPrep")
      .forEach((week, index) => {
        const units = selectedUnitIds.map((id) => unitById(course, id)).filter(Boolean);
        week.examPrepMaterials = units.map((unit) => ({
          unitId: unit.id,
          unitCode: unit.code,
          unitName: unit.name,
          materialName: "실전대비북 + 완자 마무리",
          materials: materialForReview(course, unit, 5, progressWeeks + index + 1, progressWeeks, "examPrep").items,
        }));
      });
  }

  function buildWarnings(course, selectedUnitIds, weeks, manualAnchors, progressWeeks) {
    const selectedSet = new Set(selectedUnitIds);
    const anchorWeekByUnit = new Map();
    weeks.forEach((week) => {
      week.progressUnits.forEach((unit) => anchorWeekByUnit.set(unit.id, week.week));
    });

    const warnings = [];
    Object.keys(manualAnchors || {}).forEach((weekKey) => {
      const weekNumber = Number(weekKey);
      if (weekNumber > progressWeeks) {
        warnings.push(`${weekNumber}주차는 시험대비 주차라서 진도 고정에서 제외했습니다.`);
      }
    });

    selectedUnitIds.forEach((unitId) => {
      const unit = unitById(course, unitId);
      if (!unit) return;
      unit.prerequisites.forEach((pre) => {
        const preUnit = unitById(course, pre.id);
        const preLabel = preUnit ? formatUnit(preUnit) : `${pre.id}강`;

        if (!selectedSet.has(pre.id)) {
          if (pre.strength === "strong") {
            warnings.push(`${formatUnit(unit)} 전에 ${preLabel} 선수지식이 필요합니다. 시험범위 밖이면 미니 브리지를 넣으세요.`);
          }
          return;
        }

        const unitWeek = anchorWeekByUnit.get(unit.id);
        const preWeek = anchorWeekByUnit.get(pre.id);
        if (pre.strength === "strong" && unitWeek && preWeek && preWeek > unitWeek) {
          warnings.push(`${formatUnit(unit)}가 ${preLabel}보다 먼저 배치되었습니다. 강한 선수관계 위반입니다.`);
        }
      });
    });

    return Array.from(new Set(warnings));
  }

  function buildCompressionNotes(course, selectedUnitIds, weeks, totalWeeks, prepWeeks) {
    const progressWeeks = totalWeeks - prepWeeks;
    const notes = [];
    selectedUnitIds.forEach((unitId) => {
      const unit = unitById(course, unitId);
      if (!unit) return;
      const events = weeks.flatMap((week) => week.reviewEvents).filter((event) => event.unitId === unitId && !event.skipped);
      const normalRounds = events.filter((event) => event.reviewWeek <= progressWeeks).map((event) => event.round);
      const anchorWeek = events.length ? events[0].anchorWeek : null;
      if (!anchorWeek) return;

      if (!normalRounds.includes(1)) {
        notes.push(`${formatUnit(unit)}: 1차 복습이 없습니다. 수동 점검이 필요합니다.`);
      } else if (!normalRounds.includes(2)) {
        notes.push(`${formatUnit(unit)}: 진도 주차가 늦어 기출픽 회차를 시험대비 회수로 흡수합니다.`);
      } else if (!normalRounds.includes(3)) {
        notes.push(`${formatUnit(unit)}: 셀파 회차는 시험대비 기간에서 실전대비북 + 완자 마무리로 흡수합니다.`);
      }
    });
    return notes;
  }

  function buildTrimNotes(weeks) {
    return weeks
      .map((week) => {
        const count = week.reviewEvents.filter((event) => event.autoTrimmed).length;
        return count ? `${week.week}주차: 복습 ${count}개를 자동 제외했습니다.` : "";
      })
      .filter(Boolean);
  }

  function generatePlan(options, courseInput) {
    const course = courseInput || COURSE;
    if (!course) throw new Error("통합과학1 마스터 데이터가 없습니다.");

    const totalWeeks = clamp(Number(options.totalWeeks) || 8, 3, 20);
    const prepWeeks = clamp(Number(options.prepWeeks) || 2, 1, totalWeeks - 1);
    const progressWeeks = totalWeeks - prepWeeks;
    const currentWeek = clamp(Number(options.currentWeek) || 1, 1, totalWeeks);
    const reviewModeKey = "full";
    const reviewMode = resolveReviewMode(reviewModeKey);
    const manualAnchors = normalizeManualAnchors(options.manualAnchors || {});
    const selectedUnitIds = uniqNumbers([...(options.selectedUnitIds || []), ...manualAnchorIds(manualAnchors)]).filter((id) => unitById(course, id));

    if (selectedUnitIds.length === 0) {
      throw new Error("시험범위를 최소 1개 이상 선택해야 합니다.");
    }

    const weeks = createWeeks(totalWeeks, prepWeeks);
    const anchoredIds = applyManualAnchors(course, weeks, manualAnchors, progressWeeks);
    const remainingUnitIds = selectedUnitIds.filter((id) => !anchoredIds.has(id));
    const selectedGroups = buildSelectedGroups(course, selectedUnitIds);
    const remainingGroups = buildSelectedGroups(course, remainingUnitIds);
    const orderedGroups = orderGroups(course, remainingGroups, remainingUnitIds);
    const availableWeekNumbers = Array.from({ length: progressWeeks }, (_, index) => index + 1).filter((week) => !weeks[week - 1].manualAnchor);

    assignGroupsToWeeks(orderedGroups, weeks, progressWeeks, availableWeekNumbers);
    addReviewEvents(course, weeks, totalWeeks, prepWeeks, reviewMode);
    addExamPrepMaterials(course, weeks, selectedUnitIds, totalWeeks, prepWeeks);

    const warnings = buildWarnings(course, selectedUnitIds, weeks, manualAnchors, progressWeeks);
    const groupCount = selectedGroups.length;
    if (groupCount > progressWeeks) {
      warnings.push(`선택 묶음 ${groupCount}개를 ${progressWeeks}개 진도 주차에 배치해야 하므로 일부 주차에 묶음이 2개 이상 들어갑니다.`);
    }
    if (remainingGroups.length > availableWeekNumbers.length && availableWeekNumbers.length > 0) {
      warnings.push(`고정 주차를 제외하면 남은 진도 주차가 ${availableWeekNumbers.length}개라서 일부 주차에 진도가 합쳐집니다.`);
    }

    const compressionNotes = buildCompressionNotes(course, selectedUnitIds, weeks, totalWeeks, prepWeeks).concat(buildTrimNotes(weeks));
    const selectedUnits = selectedUnitIds.map((id) => unitById(course, id)).filter(Boolean).map(slimUnit);

    return {
      version: 2,
      generatedAt: new Date().toISOString(),
      courseId: course.id,
      courseTitle: course.title,
      settings: {
        totalWeeks,
        prepWeeks,
        progressWeeks,
        currentWeek,
        reviewMode: reviewModeKey,
        reviewModeLabel: reviewMode.label,
        selectedUnitIds,
      },
      selectedUnits,
      selectedGroups,
      orderedGroups: orderedGroups.map((group) => ({
        id: group.id,
        name: group.name,
        difficulty: group.difficulty,
        unitIds: group.unitIds,
      })),
      manualAnchors,
      weeks,
      warnings,
      compressionNotes,
    };
  }

  function regenerateSection(section) {
    section.settings = normalizeSettings({
      ...section.settings,
      selectedUnitIds: uniqNumbers([...section.settings.selectedUnitIds, ...manualAnchorIds(section.manualAnchors)]),
    });
    section.manualAnchors = normalizeManualAnchors(section.manualAnchors);
    section.plan = generatePlan({ ...section.settings, manualAnchors: section.manualAnchors }, COURSE);
    section.settings = { ...section.plan.settings };
    section.updatedAt = new Date().toISOString();
    return section;
  }

  function createSection(name, settings, manualAnchors) {
    const now = new Date().toISOString();
    const section = {
      id: createId("section"),
      name: (name || "").trim() || `진도 ${state.sections.length + 1}`,
      settings: normalizeSettings(settings),
      manualAnchors: normalizeManualAnchors(manualAnchors || {}),
      plan: null,
      createdAt: now,
      updatedAt: now,
    };
    return regenerateSection(section);
  }

  function saveState() {
    if (!global.localStorage) return;
    global.localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function loadState() {
    if (!global.localStorage) return;
    const raw = global.localStorage.getItem(STORE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.sections)) {
        const normalizedDraft = normalizeSettings(parsed.draft || createDefaultState().draft);
        state = {
          ...createDefaultState(),
          ...parsed,
          uiVersion: UI_VERSION,
          tab: parsed.tab === "table" ? "table" : "dashboard",
          draft: { ...normalizedDraft, name: parsed.draft?.name || "" },
          sections: parsed.sections.map((section) =>
            regenerateSection({
              ...section,
              settings: normalizeSettings(section.settings || section.plan?.settings || {}),
              manualAnchors: normalizeManualAnchors(section.manualAnchors || {}),
            }),
          ),
        };
        if (!state.sections.some((section) => section.id === state.selectedSectionId)) {
          state.selectedSectionId = state.sections[0]?.id || null;
        }
        return;
      }

      if (parsed.plan || parsed.settings) {
        const migrated = createSection("기존 진도", normalizeSettings(parsed.settings || parsed.plan?.settings || {}), {});
        state = {
          ...createDefaultState(),
          selectedSectionId: migrated.id,
          sections: [migrated],
        };
      }
    } catch (error) {
      console.warn("저장된 계획을 불러오지 못했습니다.", error);
      state = createDefaultState();
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function visibleReviewEvents(week) {
    return (week?.reviewEvents || []).filter((event) => !event.skipped);
  }

  function unitPillsHtml(units) {
    if (!units || units.length === 0) return "<span class=\"muted\">새 진도 없음</span>";
    return units
      .map((unit) => `<span class="pill difficulty-${unit.difficulty}">${escapeHtml(unit.code)} ${escapeHtml(unit.name)}</span>`)
      .join("");
  }

  function materialListHtml(materials) {
    if (!materials || materials.length === 0) return "";
    return `<details class="file-details">
      <summary>파일명 보기</summary>
      <ul class="material-list">${materials
        .map(
          (item) =>
            `<li>
              <strong>${escapeHtml(item.book)}</strong>
              <span>${escapeHtml(item.folder)}</span>
              <code>${escapeHtml(item.file)}</code>
              <small>${escapeHtml(item.detail || "")}</small>
            </li>`,
        )
        .join("")}</ul>
    </details>`;
  }

  function weekStripHtml(section, currentWeek) {
    return `<div class="week-strip" aria-label="주차 선택">${section.plan.weeks
      .map((week) => {
        const reviews = visibleReviewEvents(week).length;
        const active = week.week === currentWeek ? "active" : "";
        const fixed = week.manualAnchor ? " fixed" : "";
        return `<button type="button" class="week-chip ${week.type} ${active}${fixed}" data-week-jump="${week.week}">
          <strong>${week.week}주</strong>
          <span>${week.type === "examPrep" ? "시험" : `${week.progressUnits.length || 0}/${reviews}`}</span>
        </button>`;
      })
      .join("")}</div>`;
  }

  function homeworkMessages(week) {
    return Array.from(new Set(visibleReviewEvents(week).map((event) => event.homeworkMessage).filter(Boolean)));
  }

  function materialNames(events) {
    return Array.from(new Set(events.map((event) => event.materialName).filter(Boolean)));
  }

  function reviewCardHtml(event) {
    const printLabel = event.homeworkMessage ? event.homeworkMessage : event.studentLabel || "프린트 자료";
    return `<article class="review-card">
      <div class="review-main">
        <div>
          <strong>${escapeHtml(event.unitCode)} ${escapeHtml(event.unitName)}</strong>
          <span>${escapeHtml(event.label)} · ${escapeHtml(event.materialName)}</span>
        </div>
        <em>${escapeHtml(event.difficulty)}</em>
      </div>
      <p>${escapeHtml(printLabel)}</p>
      ${materialListHtml(event.materials)}
    </article>`;
  }

  function unitSelectorHtml(selectedIds, inputName, compact) {
    const selected = new Set(selectedIds);
    return `<div class="${compact ? "unit-list compact" : "unit-list"}">${COURSE.units
      .map(
        (unit) => `<label class="unit-check difficulty-${unit.difficulty}">
          <input class="${inputName}" type="checkbox" value="${unit.id}" ${selected.has(unit.id) ? "checked" : ""}>
          <span>${unit.code}</span>
          <strong>${escapeHtml(unit.name)}</strong>
          <em>${unit.difficulty}</em>
        </label>`,
      )
      .join("")}</div>`;
  }

  function renderSectionManager() {
    const root = document.querySelector("#sectionManager");
    if (!root) return;
    const selected = selectedSection();
    const draftSelected = state.draft.selectedUnitIds || DEFAULT_SELECTED_UNITS;
    const openCreate = state.sections.length === 0 ? "open" : "";

    root.innerHTML = `<section class="panel create-panel">
      <details class="create-details" ${openCreate}>
        <summary>
          <div>
            <span>진도 만들기</span>
            <strong>섹션 이름과 범위를 정하면 하나의 진도표가 만들어집니다.</strong>
          </div>
          <b>새 섹션</b>
        </summary>
        <form id="sectionForm" class="create-form">
          <label>섹션 이름
            <input id="draftName" name="name" value="${escapeHtml(state.draft.name || "")}" placeholder="예: 중간고사, 1학기 기말">
          </label>
          <div class="form-grid">
            <label>총 준비 주차 N
              <input id="draftTotalWeeks" name="totalWeeks" type="number" min="3" max="20" inputmode="numeric" value="${escapeHtml(state.draft.totalWeeks)}">
            </label>
            <label>시험대비 주차 P
              <input id="draftPrepWeeks" name="prepWeeks" type="number" min="1" max="4" inputmode="numeric" value="${escapeHtml(state.draft.prepWeeks)}">
            </label>
            <label>현재 주차
              <input id="draftCurrentWeek" name="currentWeek" type="number" min="1" max="20" inputmode="numeric" value="${escapeHtml(state.draft.currentWeek)}">
            </label>
          </div>
          <div class="range-head">
            <strong>시험범위</strong>
            <div class="button-row compact">
              <button type="button" data-range-action="sample">예시</button>
              <button type="button" data-range-action="all">전체</button>
              <button type="button" data-range-action="clear">해제</button>
            </div>
          </div>
          ${unitSelectorHtml(draftSelected, "draft-unit", false)}
          <button type="submit" class="primary wide">진도 만들기</button>
        </form>
      </details>
    </section>

    <section class="section-list" aria-label="진도 섹션 목록">
      ${state.sections.length
        ? state.sections
            .map((section) => {
              const active = selected?.id === section.id ? "active" : "";
              return `<article class="section-card ${active}">
                <button type="button" data-section-select="${escapeHtml(section.id)}">
                  <strong>${escapeHtml(section.name)}</strong>
                  <span>${section.settings.totalWeeks}주 · ${section.settings.selectedUnitIds.length}강</span>
                </button>
                <button type="button" class="icon-button danger" data-section-delete="${escapeHtml(section.id)}" aria-label="${escapeHtml(section.name)} 삭제">삭제</button>
              </article>`;
            })
            .join("")
        : `<article class="empty-card">아직 만든 진도 섹션이 없습니다.</article>`}
    </section>`;
  }

  function renderDashboard() {
    const root = document.querySelector("#dashboard");
    if (!root) return;
    const section = selectedSection();
    if (!section) {
      root.innerHTML = `<section class="empty-state">
        <h2>진도 섹션을 먼저 만들어 주세요.</h2>
        <p>예시 범위가 기본으로 들어가 있으니 이름만 넣고 바로 생성해도 됩니다.</p>
      </section>`;
      return;
    }

    const currentWeek = clamp(Number(section.settings.currentWeek) || 1, 1, section.settings.totalWeeks);
    const week = section.plan.weeks[currentWeek - 1];
    const reviews = visibleReviewEvents(week);
    const homeworks = homeworkMessages(week);
    const materials = materialNames(reviews);
    const status = week.type === "examPrep" ? "시험대비" : "진도";

    root.innerHTML = `<section class="dashboard-shell">
      <article class="section-hero">
        <div>
          <span>${escapeHtml(section.plan.courseTitle)} · ${section.settings.totalWeeks}주 중 ${currentWeek}주차</span>
          <h2>${escapeHtml(section.name)}</h2>
        </div>
        <b>${escapeHtml(status)}</b>
      </article>
      ${weekStripHtml(section, currentWeek)}
      <section class="today-summary">
        <article>
          <span>이번 주 진도</span>
          <strong>${week.progressUnits.length ? week.progressUnits.map((unit) => unit.code).join(", ") : "없음"}</strong>
          <p>${escapeHtml(week.role)}${week.manualAnchor ? " · 고정됨" : ""}</p>
        </article>
        <article>
          <span>이번 주 복습</span>
          <strong>${reviews.length}개</strong>
          <p>${materials.length ? escapeHtml(materials.slice(0, 2).join(" · ")) : "복습 없음"}</p>
        </article>
      </section>
      <section class="work-card">
        <div class="card-title">
          <h3>학생에게 보낼 완자 숙제 문구</h3>
          <span>${homeworks.length}개</span>
        </div>
        ${homeworks.length
          ? `<div class="message-list">${homeworks.map((message) => `<button type="button" data-copy-text="${escapeHtml(message)}">${escapeHtml(message)}</button>`).join("")}</div>`
          : `<p class="muted">이번 주 1차 복습 완자 숙제 문구가 없습니다.</p>`}
      </section>
      <section class="work-card">
        <div class="card-title">
          <h3>새 진도</h3>
          <span>${week.progressUnits.length}개</span>
        </div>
        <div class="pill-row">${unitPillsHtml(week.progressUnits)}</div>
      </section>
      <section class="work-card">
        <div class="card-title">
          <h3>복습 자료</h3>
          <span>${reviews.length}개</span>
        </div>
        ${reviews.length ? reviews.map(reviewCardHtml).join("") : `<p class="muted">복습 없음</p>`}
      </section>
      ${section.plan.warnings.length || section.plan.compressionNotes.length
        ? `<section class="notice-list">
            ${section.plan.warnings.map((item) => `<p class="warn">${escapeHtml(item)}</p>`).join("")}
            ${section.plan.compressionNotes.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
          </section>`
        : ""}
    </section>`;
  }

  function anchorFormHtml(section, week) {
    if (week.type === "examPrep") {
      return `<p class="muted">시험대비 주차에는 새 진도를 고정하지 않습니다.</p>`;
    }
    const currentIds = (section.manualAnchors[String(week.week)] || week.progressUnits.map((unit) => unit.id)).slice();
    return `<details class="anchor-details">
      <summary>진도 바꾸기</summary>
      <form data-anchor-form="${week.week}">
        ${unitSelectorHtml(currentIds, `anchor-unit-${week.week}`, true)}
        <div class="button-row">
          <button type="submit" class="primary">이 주차 고정하고 재계산</button>
          <button type="button" data-anchor-clear="${week.week}">고정 해제</button>
        </div>
      </form>
    </details>`;
  }

  function shortReviewRowsHtml(week) {
    const reviews = visibleReviewEvents(week);
    if (!reviews.length) return `<p class="muted">복습 없음</p>`;
    return `<ul class="short-list">${reviews
      .map(
        (event) =>
          `<li><strong>${escapeHtml(event.unitCode)}</strong><span>${escapeHtml(event.label)}</span><em>${escapeHtml(event.materialName)}</em></li>`,
      )
      .join("")}</ul>`;
  }

  function shortMaterialsHtml(week) {
    const reviews = visibleReviewEvents(week);
    const homeworks = homeworkMessages(week);
    const materials = materialNames(reviews);
    if (week.type === "examPrep" && week.examPrepMaterials.length) {
      materials.push("실전대비북 + 완자 마무리");
    }
    return `<div class="material-summary">
      ${homeworks.map((message) => `<p class="homework">${escapeHtml(message)}</p>`).join("")}
      ${Array.from(new Set(materials)).map((material) => `<span>${escapeHtml(material)}</span>`).join("") || `<p class="muted">자료 없음</p>`}
    </div>`;
  }

  function parsePageRange(page) {
    const clean = String(page || "").replace(/^p/i, "");
    const [startText, endText] = clean.split("-");
    const start = Number(startText);
    const end = Number(endText || startText);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    return { start, end };
  }

  function formatPageRange(range) {
    if (range.start === range.end) return `p.${range.start}`;
    return `p.${range.start}~${range.end}`;
  }

  function formatWanjaPages(unit) {
    const ranges = (unit?.wanjaHomework?.pages || []).map(parsePageRange).filter(Boolean);
    if (!ranges.length) return "";
    const merged = [];
    ranges
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .forEach((range) => {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end + 1) {
          last.end = Math.max(last.end, range.end);
          return;
        }
        merged.push({ ...range });
      });
    return merged.map(formatPageRange).join(", ");
  }

  function homeworkLineForEvent(event) {
    if (event.materialName === "완자 내신만점 문제 + 실력 UP") {
      const unit = unitById(COURSE, event.unitId);
      const pages = formatWanjaPages(unit);
      return `완자 ${event.unitCode}강${pages ? ` ${pages}` : ""} 풀기`;
    }
    if (event.materialName === "기출픽") return `기출픽 ${event.unitCode}강 프린트 풀기`;
    if (event.materialName === "셀파") return `셀파 ${event.unitCode}강 프린트 풀기`;
    if (event.materialName === "실전대비북 + 완자 마무리") {
      return `실전대비북 ${event.unitCode}강 + 완자 마무리 프린트 풀기`;
    }
    return `${event.unitCode}강 ${event.studentLabel || event.materialName}`;
  }

  function weekHomeworkText(section, week) {
    const reviews = visibleReviewEvents(week);
    const lines = reviews.map(homeworkLineForEvent);

    if (week.type === "examPrep" && week.examPrepMaterials.length) {
      const examPrepLines = week.examPrepMaterials.map((item) => `실전대비북 ${item.unitCode}강 + 완자 마무리 프린트 풀기`);
      examPrepLines.forEach((line) => {
        if (!lines.includes(line)) lines.push(line);
      });
    }

    const title = "[숙제]";
    if (!lines.length) return `${title}\n숙제 없음`;
    return `${title}\n${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
  }

  function homeworkCopyHtml(section, week) {
    const text = weekHomeworkText(section, week);
    return `<div class="homework-copy">
      <textarea readonly rows="5" data-homework-text="${week.week}">${escapeHtml(text)}</textarea>
      <button type="button" class="primary wide" data-copy-homework="${week.week}">카톡 숙제 문구 복사</button>
    </div>`;
  }

  function renderPlanTable() {
    const root = document.querySelector("#planTable");
    if (!root) return;
    const section = selectedSection();
    if (!section) {
      root.innerHTML = `<section class="empty-state">
        <h2>전체표가 아직 없습니다.</h2>
        <p>이번 주 화면에서 진도 섹션을 만들면 전체표가 생성됩니다.</p>
      </section>`;
      return;
    }

    root.innerHTML = `<section class="table-head">
      <div>
        <span>전체표</span>
        <h2>${escapeHtml(section.name)}</h2>
      </div>
      <p>${section.settings.totalWeeks}주 계획 · ${section.settings.selectedUnitIds.length}강</p>
    </section>
    <section class="week-table">${section.plan.weeks
      .map(
        (week) => `<article class="week-row ${week.type} ${week.manualAnchor ? "manual" : ""}">
          <header>
            <div>
              <strong>${week.week}주차</strong>
              <span>${escapeHtml(week.role)}</span>
            </div>
            ${week.manualAnchor ? `<b>고정됨</b>` : week.type === "examPrep" ? `<b>시험대비</b>` : ""}
          </header>
          <div class="week-columns">
            <section>
              <h3>진도</h3>
              <div class="pill-row">${unitPillsHtml(week.progressUnits)}</div>
              ${anchorFormHtml(section, week)}
            </section>
            <section>
              <h3>복습</h3>
              ${shortReviewRowsHtml(week)}
            </section>
            <section>
              <h3>자료</h3>
              ${shortMaterialsHtml(week)}
            </section>
            <section>
              <h3>카톡 숙제</h3>
              ${homeworkCopyHtml(section, week)}
            </section>
          </div>
        </article>`,
      )
      .join("")}</section>`;
  }

  function renderTabs() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === state.tab);
    });
    document.querySelectorAll(".screen").forEach((screen) => {
      screen.classList.toggle("active", screen.id === `screen-${state.tab}`);
    });
  }

  function copyText(text, button) {
    const showCopied = () => {
      if (!button) return;
      const original = button.textContent;
      button.textContent = "복사됨";
      window.setTimeout(() => {
        button.textContent = original;
      }, 900);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(showCopied).catch(() => fallbackCopyText(text, showCopied));
      return;
    }
    fallbackCopyText(text, showCopied);
  }

  function fallbackCopyText(text, onSuccess) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand("copy");
      onSuccess?.();
    } catch (error) {
      window.prompt("문구를 복사하세요.", text);
    } finally {
      textarea.remove();
    }
  }

  function renderAll() {
    renderSectionManager();
    renderDashboard();
    renderPlanTable();
    renderTabs();
  }

  function readDraftFromDom() {
    const selectedUnitIds = Array.from(document.querySelectorAll(".draft-unit:checked")).map((input) => Number(input.value));
    state.draft = normalizeSettings({
      totalWeeks: document.querySelector("#draftTotalWeeks")?.value,
      prepWeeks: document.querySelector("#draftPrepWeeks")?.value,
      currentWeek: document.querySelector("#draftCurrentWeek")?.value,
      reviewMode: "full",
      selectedUnitIds,
    });
    state.draft.name = document.querySelector("#draftName")?.value.trim() || "";
  }

  function setDraftRange(action) {
    if (action === "sample") state.draft.selectedUnitIds = DEFAULT_SELECTED_UNITS.slice();
    if (action === "all") state.draft.selectedUnitIds = COURSE.units.map((unit) => unit.id);
    if (action === "clear") state.draft.selectedUnitIds = [];
    saveState();
    renderAll();
  }

  function createSectionFromDraft() {
    readDraftFromDom();
    const section = createSection(state.draft.name, state.draft, {});
    state.sections.unshift(section);
    state.selectedSectionId = section.id;
    state.draft.name = "";
    state.tab = "dashboard";
    saveState();
    renderAll();
  }

  function selectSection(id) {
    if (!state.sections.some((section) => section.id === id)) return;
    state.selectedSectionId = id;
    saveState();
    renderAll();
  }

  function deleteSection(id) {
    const section = state.sections.find((item) => item.id === id);
    if (!section) return;
    if (!global.confirm(`'${section.name}' 섹션을 삭제할까요?`)) return;
    state.sections = state.sections.filter((item) => item.id !== id);
    if (state.selectedSectionId === id) {
      state.selectedSectionId = state.sections[0]?.id || null;
    }
    saveState();
    renderAll();
  }

  function updateSectionWeek(section, weekNumber) {
    section.settings.currentWeek = clamp(Number(weekNumber), 1, section.settings.totalWeeks);
    regenerateSection(section);
    saveState();
    renderAll();
  }

  function saveManualAnchor(form) {
    const section = selectedSection();
    if (!section) return;
    const weekNumber = Number(form.dataset.anchorForm);
    const progressWeeks = section.settings.totalWeeks - section.settings.prepWeeks;
    if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > progressWeeks) return;

    const unitIds = uniqNumbers(Array.from(form.querySelectorAll("input:checked")).map((input) => Number(input.value)));
    Object.keys(section.manualAnchors).forEach((weekKey) => {
      if (Number(weekKey) === weekNumber) return;
      section.manualAnchors[weekKey] = section.manualAnchors[weekKey].filter((id) => !unitIds.includes(id));
      if (section.manualAnchors[weekKey].length === 0) {
        delete section.manualAnchors[weekKey];
      }
    });

    if (unitIds.length) {
      section.manualAnchors[String(weekNumber)] = unitIds;
      section.settings.selectedUnitIds = uniqNumbers([...section.settings.selectedUnitIds, ...unitIds]);
    } else {
      delete section.manualAnchors[String(weekNumber)];
    }

    section.settings.currentWeek = weekNumber;
    regenerateSection(section);
    saveState();
    renderAll();
  }

  function clearManualAnchor(weekNumber) {
    const section = selectedSection();
    if (!section) return;
    delete section.manualAnchors[String(weekNumber)];
    section.settings.currentWeek = clamp(Number(weekNumber), 1, section.settings.totalWeeks);
    regenerateSection(section);
    saveState();
    renderAll();
  }

  function attachEvents() {
    document.addEventListener("click", (event) => {
      const tabButton = event.target.closest("[data-tab]");
      if (tabButton) {
        state.tab = tabButton.dataset.tab === "table" ? "table" : "dashboard";
        saveState();
        renderAll();
        return;
      }

      const rangeButton = event.target.closest("[data-range-action]");
      if (rangeButton) {
        setDraftRange(rangeButton.dataset.rangeAction);
        return;
      }

      const sectionButton = event.target.closest("[data-section-select]");
      if (sectionButton) {
        selectSection(sectionButton.dataset.sectionSelect);
        return;
      }

      const deleteButton = event.target.closest("[data-section-delete]");
      if (deleteButton) {
        deleteSection(deleteButton.dataset.sectionDelete);
        return;
      }

      const weekButton = event.target.closest("[data-week-jump]");
      if (weekButton) {
        const section = selectedSection();
        if (section) updateSectionWeek(section, Number(weekButton.dataset.weekJump));
        return;
      }

      const clearButton = event.target.closest("[data-anchor-clear]");
      if (clearButton) {
        clearManualAnchor(Number(clearButton.dataset.anchorClear));
        return;
      }

      const copyButton = event.target.closest("[data-copy-text]");
      if (copyButton) {
        copyText(copyButton.dataset.copyText, copyButton);
        return;
      }

      const homeworkCopyButton = event.target.closest("[data-copy-homework]");
      if (homeworkCopyButton) {
        const container = homeworkCopyButton.closest(".homework-copy");
        const textarea = container?.querySelector("textarea");
        copyText(textarea?.value || "", homeworkCopyButton);
      }
    });

    document.addEventListener("submit", (event) => {
      if (event.target.matches("#sectionForm")) {
        event.preventDefault();
        try {
          createSectionFromDraft();
        } catch (error) {
          global.alert(error.message);
        }
        return;
      }

      const anchorForm = event.target.closest("[data-anchor-form]");
      if (anchorForm) {
        event.preventDefault();
        saveManualAnchor(anchorForm);
      }
    });

    document.addEventListener("change", (event) => {
      if (event.target.closest("#sectionForm")) {
        readDraftFromDom();
        saveState();
      }
    });

    document.addEventListener("input", (event) => {
      if (event.target.matches("#draftName")) {
        state.draft.name = event.target.value;
        saveState();
      }
    });
  }

  function init() {
    loadState();
    if (state.sections.length > 0 && !state.selectedSectionId) {
      state.selectedSectionId = state.sections[0].id;
    }
    attachEvents();
    renderAll();
    saveState();

    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  const api = {
    generatePlan,
    createSection,
    regenerateSection,
    materialForReview,
    state: () => state,
  };

  global.ProgressReviewApp = api;

  if (global.document) {
    document.addEventListener("DOMContentLoaded", init);
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
