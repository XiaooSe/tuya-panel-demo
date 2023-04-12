/* eslint-disable indent */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable prettier/prettier */
/* eslint-disable camelcase */
import { DevInfo, GlobalToast } from 'tuya-panel-kit';
import { Dispatch } from 'redux';
import { createAction, handleActions } from 'redux-actions';
import _ from 'lodash';
import dragon from '@tuya/tuya-panel-dragon-sdk';
import { CloudTimingCategory } from '@config';
import { dimmerModeSmeaModeMaps, defaultLocalMusic } from '@config/default';
import PresetScenes from '@config/default/scene';
import DpCodes from '@config/dpCodes';
import { avgSplit, getHomeTabFromWorkMode, getPreviewColorDatas, nToHS } from '@utils';
import * as TaskManager from '@utils/taskManager';
import SmearFormater from '@config/dragon/SmearFormater';
import {
  getDeviceCloudData,
  saveDeviceCloudData,
  deleteDeviceCloudData,
  addTimer,
  updateTimer,
  updateTimerStatus,
  removeTimer,
  getCategoryTimerList,
} from '@api';
import {
  DimmerValue,
  SceneDataType,
  SceneValueType,
  HomeTab,
  SmearDataType,
  WorkMode,
  DimmerMode,
  SmearMode,
  DimmerTab,
} from '@types';
import Strings from '@i18n';
import { DpState, GetState, UiState, UiStatePayload } from '../type';

const { powerCode, workModeCode, smearCode, sceneCode, countdownCode } = DpCodes;
const smearFormater = new SmearFormater();

type UpdateDevInfoPayload = DevInfo;
type UpdateDpStatePayload = Partial<DpState> & { [key: string]: DpState }; // Make sure there is at least one key-value pair.

// sync actions

const devInfoChange = createAction<UpdateDevInfoPayload>('_DEVINFOCHANGE_');
const deviceChange = createAction<UpdateDevInfoPayload>('_DEVICECHANGED_');
const updateDp = createAction<UpdateDpStatePayload>('UPDATE_DP');
const consoleChange = createAction('CONSOLECHNAGE');
const clearConsole = createAction('CLEARCONSOLE');
const updatePanelState = createAction('UPDATE_PANEL_STATE');
const updateUI = createAction<UiStatePayload>('UPDATE_UI');
const updateCloudState = createAction('UPDATE_CLOUD_STATE');
const replaceCloudState = createAction('REPLACE_CLOUD_STATE');
const updateLocalMusic = createAction('UPDATE_LOCAL_MUSIC');

// async actions

export const asyncDevInfoChange = (data: any) => async (dispatch: Dispatch) => {
  dispatch(devInfoChange(data));
  data.state && dispatch(updateDp(data.state));
  dispatch(updateUI({ ledNumber: +data?.panelConfig?.fun?.strip_leaf || 20 }));
};

/** Initialize lights in cloudState */
export const getCloudStates = () => async (dispatch: Dispatch) => {
  try {
    const data: any = (await getDeviceCloudData()) || {};
    const localMusicList: MicMusicData[] = _.cloneDeep(defaultLocalMusic);

    const updates: any = Object.keys(data).reduce((acc, cur) => {
      const val = data[cur];
      acc[cur] = typeof val === 'string' ? JSON.parse(val) : val;

      // local music
      if (/^local_music_\d+$/.test(cur) && acc[cur]) {
        const id = +cur.substr(12);
        for (let i = 0; i < localMusicList.length; i++) {
          if (localMusicList[i].id === id && acc[cur]) {
            localMusicList[i] = acc[cur];
          }
        }
      }

      return acc;
    }, {});
    updates.loaded = updates.loaded?.status ?? { status: 0 };
    updates.localMusicList = localMusicList;
    dispatch(replaceCloudState(updates));
  } catch (error) {
    console.error(error);
  }
};

export const asyncUpdateDp = (d: DpState) => (dispatch: Dispatch, getState: GetState) => {
  dispatch(updateDp(d));

  const {
    uiState: { homeTab, dimmerValue },
  } = getState();
  const uiUpdates: UiStatePayload = {};
  const workMode: WorkMode = d[workModeCode];

  // Update homeTab based on workMode (only update barMode if currently on workMode page)
  if (workMode !== undefined) {
    if ([HomeTab.dimmer, HomeTab.scene, HomeTab.music].includes(homeTab)) {
      uiUpdates.homeTab = getHomeTabFromWorkMode(workMode);
    }
  }
  // Handle smear dp report
  if (d[smearCode] !== undefined) {
    // @ts-ignore wtf
    dispatch(updateLights(d[smearCode], true));
    // Update dimmerValue based on smear dp report
    const {
      dimmerMode,
      smearMode,
      hue,
      saturation,
      value,
      brightness,
      temperature,
      combination,
    }: SmearDataType = d[smearCode];
    if (smearMode === SmearMode.clear) return; // If it is erasing, it won’t affect dimmerValue
    // @ts-ignore wtf
    dispatch(handleDimmerModeChange(dimmerMode));
    const dimmerValueMaps = {
      [DimmerMode[0]]: { [DimmerMode[0]]: { brightness, temperature } },
      [DimmerMode[1]]: {
        [DimmerMode[1]]: { hue, saturation, value },
        [DimmerMode[2]]: { ...dimmerValue[DimmerMode[2] as DimmerTab], value },
      },
      [DimmerMode[2]]: {
        [DimmerMode[1]]: { ...dimmerValue[DimmerMode[1] as DimmerTab], value },
        [DimmerMode[2]]: { hue, saturation, value },
      },
      [DimmerMode[3]]: { [DimmerMode[3]]: combination },
    };
    uiUpdates.dimmerValue = {
      ...dimmerValue,
      ...dimmerValueMaps[DimmerMode[dimmerMode]],
    };
  }
  if (Object.keys(uiUpdates).length) dispatch(updateUI(uiUpdates));
};

export const handleToChangeLights =
  (data: any = {}, isSave = false) =>
  async (dispatch: Dispatch, getState: GetState) => {
    const {
      dpState: {
        [smearCode]: { effect },
      },
      uiState: { dimmerMode, smearMode, ledNumber },
    } = getState();
    const smearData = { dimmerMode, smearMode, effect, ledNumber, ...data };
    // @ts-ignore wtf
    dispatch(updateLights(smearData, isSave));
    if (!isSave) return;

    const fixedWorkMode = [
      DimmerMode.colour,
      DimmerMode.colourCard,
      DimmerMode.combination,
    ].includes(dimmerMode)
      ? WorkMode.colour
      : WorkMode.white;
    dragon.putDpData(
      {
        [smearCode]: smearData,
      },
      { checkCurrent: false, useThrottle: false, clearThrottle: true }
    );
    dragon.putDpData({
      [powerCode]: true,
      [workModeCode]: fixedWorkMode,
      // }, { checkCurrent: false });
    });
  };

/** Click on the LED strip */
export const handlePressLights =
  (data: any = {}, isSave = false) =>
  async (dispatch: Dispatch, getState: GetState) => {
    const {
      uiState: { dimmerValue, dimmerMode, smearMode },
    } = getState();
    // Only update the color when SmearMode is ‘single’ or ‘clear’ and dimmerMode is ‘colour’ or ‘colourCard’ on the color bulb and color card tabs
    if (
      !(
        [SmearMode.single, SmearMode.clear].includes(smearMode) &&
        [DimmerMode.colour, DimmerMode.colourCard].includes(dimmerMode)
      )
    )
      return;

    const colorData = smearMode === SmearMode.single ? dimmerValue[DimmerMode[dimmerMode]] : {};
    dispatch(
      // @ts-ignore wtf
      handleToChangeLights(
        {
          ...data,
          ...colorData,
        },
        isSave
      )
    );
  };

/** Update all lights based on smear dp */
export const updateLights =
  (smearData: SmearDataType, isSave = false) =>
  async (dispatch: Dispatch, getState: any) => {
    const { indexs = new Set(), dimmerMode, smearMode, combination = [] } = smearData;
    dispatch(
      updateUI({
        // Disable gradient button after using the paint bucket feature
        afterSmearAll: smearMode === SmearMode.all && dimmerMode !== DimmerMode.combination,
        // Disable pencil button after using the white light function of the paint bucket
        afterSmearAllWhite: smearMode === SmearMode.all && dimmerMode === DimmerMode.white,
      })
    );

    const {
      cloudState: { lights = [] },
      uiState: { ledNumber = 0 },
    } = getState();
    let newLights: any = [];
    if (dimmerMode === DimmerMode.combination) {
      // Other modes send a single color, while the combination sends multiple colors and is handled separately
      newLights = getPreviewColorDatas(combination, ledNumber).map(
        ({ hue, saturation, value }) =>
          `${nToHS(hue, 4)}${nToHS(saturation, 4)}${nToHS(value, 4)}${nToHS(0, 4)}${nToHS(0, 4)}`
      );
    } else {
      const smearDataStr = smearFormater.format(smearData);
      const color = [DimmerMode.colour, DimmerMode.colourCard].includes(dimmerMode)
        ? _.padEnd(smearDataStr.slice(10, 22), 20, '0')
        : _.padStart(smearDataStr.slice(10, 18), 20, '0');
      newLights = _.times(ledNumber, i =>
        smearMode === SmearMode.all ? color : indexs.has(i) ? color : lights[i]
      );
    }

    // Store white light and color separately
    if (dimmerMode === DimmerMode.white) {
      // @ts-ignore wtf
      dispatch(updateCloudStates('whiteLights', newLights, isSave));
    } else {
      // @ts-ignore wtf
      dispatch(updateCloudStates('lights', newLights, isSave));
    }
  };

export const updateCloudStates =
  (key: string, data: any, isSave = true) =>
  async (dispatch: Dispatch) => {
    try {
      dispatch(updateCloudState({ [key]: data }));
      if (!isSave) return;
      // Slice lights into segments with a length of 1024
      if (key === 'lights' || key === 'whiteLights') {
        // eslint-disable-next-line no-restricted-syntax
        for (const [i, s] of avgSplit(data.join(''), 1024).entries()) {
          // eslint-disable-next-line no-await-in-loop
          await saveDeviceCloudData(`${key}_${i}`, s);
        }
      } else {
        await saveDeviceCloudData(key, data);
      }
    } catch (error) {
      console.error(error);
    }
  };

export const handleHomeTabChange = (tab: HomeTab) => (dispatch: Dispatch) => {
  dispatch(updateUI({ homeTab: tab }));
};

/** Correct smearMode (after switching dimmerMode) */
export const fixSmearMode =
  (dimmerMode: DimmerMode) => (dispatch: Dispatch, getState: GetState) => {
    const {
      uiState: { smearMode },
    } = getState();
    const supportedSmearModes = dimmerModeSmeaModeMaps[dimmerMode]; // Supported smearMode for the current dimmerMode
    if (supportedSmearModes?.includes(smearMode)) return;
    dispatch(updateUI({ smearMode: supportedSmearModes[0] })); // Default to the first supported smearMode
  };

/** Handle dimmerMode change */
export const handleDimmerModeChange = (mode: DimmerMode) => (dispatch: Dispatch) => {
  // @ts-ignore wtf
  dispatch(fixSmearMode(mode));
  dispatch(updateUI({ dimmerMode: mode }));
};

/** Handle dimmer color change */
export const handleDimmerValueChange =
  (data: DimmerValue) => (dispatch: Dispatch, getState: GetState) => {
    const {
      uiState: { dimmerMode, smearMode, dimmerValue },
    } = getState();
    const dataPayload = data[DimmerMode[dimmerMode] as DimmerTab];
    dispatch(
      updateUI({
        dimmerValue: {
          ...dimmerValue,
          [DimmerMode[dimmerMode]]: dataPayload,
        },
      })
    );
    // Only paint bucket will be sent directly
    if (smearMode !== SmearMode.all) return;
    dispatch(
      // @ts-ignore wtf
      handleToChangeLights(
        {
          ...([DimmerMode.white, DimmerMode.colour, DimmerMode.colourCard].includes(dimmerMode)
            ? dataPayload
            : data),
        },
        true
      )
    );
  };

/** Process gradient operation */
export const handleSmearEffectSwitch = () => (__: Dispatch, getState: GetState) => {
  const {
    dpState: { [smearCode]: smearData },
  } = getState();
  dragon.putDpData({ [smearCode]: { ...smearData, effect: +!smearData.effect } });
};

export const handlePutSceneData = (value: SceneValueType) => async () => {
  dragon.putDpData(
    { [sceneCode]: value },
    { checkCurrent: false, useThrottle: false, clearThrottle: true }
  );
  dragon.putDpData({ [workModeCode]: 'scene', [powerCode]: true });
};

/** Scene preservation */
export const handlePutScene =
  (data: SceneDataType, isEdit = false, isSave = true) =>
  async (dispatch: Dispatch, getState: GetState) => {
    let sceneData = data;
    if (!isEdit && isSave) {
      // Update the latest scene list, making sure the saved ids are up to date
      // @ts-ignore wtf
      // await dispatch(getCloudStates());
      const {
        cloudState: { scenes = [] },
      } = getState();
      const maxId = scenes.reduce((acc, cur: any) => Math.max(acc, +cur.id), 0);

      // diy Scene id minimum 200
      const newId = Math.max(200, maxId) + 1;
      sceneData = {
        ...data,
        id: newId,
        value: {
          ...data.value,
          id: newId,
        },
      };
    }
    // @ts-ignore
    dispatch(handlePutSceneData(sceneData.value));
    if (!isSave) return;
    // @ts-ignore wtf
    await dispatch(updateCloudStates(`scene_${sceneData.id}`, sceneData, true));

    GlobalToast.show({
      text: Strings.getLang(isEdit ? 'tip_edit_success' : 'tip_add_success'),
      onFinish: () => {
        GlobalToast.hide();
      },
    });
    // Update cloudStates again
    // @ts-ignore wtf
    dispatch(getCloudStates());
  };

/** Scene preservation */
export const handleRemoveScene = (data: SceneDataType) => async (dispatch: Dispatch) => {
  // @ts-ignore wtf
  const res = await deleteDeviceCloudData(`scene_${data.id}`);
  GlobalToast.show({
    showIcon: !!res,
    text: Strings.getLang(res ? 'tip_remove_success' : 'tip_remove_fail'),
    onFinish: () => {
      GlobalToast.hide();
    },
  });
  // Update cloudStates again
  // @ts-ignore wtf
  dispatch(getCloudStates());
};

export const handlePutCountdown = (countdown: number) => (dispatch: Dispatch) => {
  dragon.putDpData({ [countdownCode]: countdown }, { checkCurrent: false });
  GlobalToast.show({
    text: Strings.getLang(countdown ? 'tip_countdown_open_success' : 'tip_countdown_close_success'),
    onFinish: () => {
      GlobalToast.hide();
    },
  });
  // @ts-ignore wtf
  dispatch(updateCloudStates('totalCountdown', String(countdown)));
};

export const getCloudTimingList = () => async (dispatch: Dispatch) => {
  // Clearing the cloud is mutually exclusive
  TaskManager.removeAll(TaskManager.TaskType.NORMAL_TIMING);
  const data: any = (await getCategoryTimerList(CloudTimingCategory)) || {};
  const cloudTimingList = _.flatMap(data.groups, item =>
    item.timers.map(it => {
      const [hour, minute] = it.time.split(':').map(Number);
      const weeks = it.loops.split('').map(Number);
      const datas = {
        ...it,
        groupId: item.id,
        weeks,
        hour,
        minute,
        power: !!it.status,
        type: 'timer',
      };
      datas.power &&
        TaskManager.add(
          {
            id: datas.timerId,
            weeks: weeks.concat(0),
            startTime: hour * 60 + minute,
            endTime: hour * 60 + minute,
          },
          TaskManager.TaskType.NORMAL_TIMING
        );
      return datas;
    })
  );
  dispatch(updateUI({ cloudTimingList }));
};

export const addCloudTiming =
  (...args: any[]) =>
  async (dispatch: Dispatch) => {
    // @ts-ignore wtf
    const res = await addTimer(...args);
    // @ts-ignore wtf
    dispatch(getCloudTimingList());
    return res;
  };

export const updateCloudTiming =
  (...args: any[]) =>
  async (dispatch: Dispatch) => {
    // @ts-ignore wtf
    const res = await updateTimer(...args);
    // @ts-ignore wtf
    dispatch(getCloudTimingList());
    return res;
  };

export const updateCloudTimingStatus =
  (...args: any[]) =>
  async (dispatch: Dispatch) => {
    // @ts-ignore wtf
    const res = await updateTimerStatus(...args);
    // @ts-ignore wtf
    dispatch(getCloudTimingList());
    return res;
  };

export const removeCloudTiming =
  (...args: any[]) =>
  async (dispatch: Dispatch) => {
    // @ts-ignore wtf
    const res = await removeTimer(...args);
    // @ts-ignore wtf
    dispatch(getCloudTimingList());
    return res;
  };

export const actions = {
  devInfoChange,
  asyncDevInfoChange,
  deviceChange,
  updateDp,
  consoleChange,
  clearConsole,
  updatePanelState,
  updateUI,
  updateLocalMusic,
  getCloudStates,
  updateLights,
  handlePressLights,
  updateCloudState,
  updateCloudStates,
  asyncUpdateDp,
  handleHomeTabChange,
  handleDimmerModeChange,
  handleDimmerValueChange,
  handleSmearEffectSwitch,
  handlePutSceneData,
  handlePutScene,
  handleRemoveScene,
  handlePutCountdown,
  getCloudTimingList,
  addCloudTiming,
  updateCloudTiming,
  removeCloudTiming,
  updateCloudTimingStatus,
};

export type Actions = { [K in keyof typeof actions]: ReturnType<(typeof actions)[K]> };

/**
 * reducers
 */
const dpState = handleActions<DpState, UpdateDpStatePayload | UpdateDevInfoPayload>(
  {
    [updateDp.toString()]: (state, action: Actions['updateDp']) => ({
      ...state,
      ...action.payload,
    }),
  },
  {} as DpState
);

const devInfo = handleActions<DevInfo>(
  {
    [devInfoChange.toString()]: (state, action) => ({
      ...state,
      ...action.payload,
    }),

    [deviceChange.toString()]: (state, action) => ({
      ...state,
      ...action.payload,
    }),
  },
  {} as DevInfo
);

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface PanelState {}

const panelState = handleActions<PanelState>(
  {
    [updatePanelState.toString()]: (state, action) => ({
      ...state,
      ...action.payload,
    }),
  },
  {} as PanelState
);

const uiState = handleActions<UiState>(
  {
    [updateUI.toString()]: (state, action) => ({
      ...state,
      ...action.payload,
    }),
  },
  {
    homeTab: HomeTab.dimmer,
    smearMode: SmearMode.all,
    dimmerMode: DimmerMode.colour,
    dimmerValue: {
      [DimmerMode[0]]: { brightness: 1000, temperature: 0 },
      [DimmerMode[1]]: { hue: 0, saturation: 1000, value: 1000 },
      [DimmerMode[2]]: { hue: 339, saturation: 980, value: 980 },
      [DimmerMode[3]]: [],
    },
    afterSmearAll: true, // Whether the paint bucket function is used on the current light strip
    afterSmearAllWhite: false, // Whether the current light strip uses the paint bucket - white light function
    scenes: PresetScenes,
    presetScenes: PresetScenes,
    totalCountdown: 0,
    ledNumber: 20,
    cloudTimingList: [],
  }
);

const cloudState = handleActions(
  {
    [updateCloudState.toString()]: (state, action) => ({
      ...state,
      ...action.payload,
    }),
    [replaceCloudState.toString()]: (__, action) => action.payload,
    [updateLocalMusic.toString()]: (state, action) => {
      const data: any = action.payload;
      // @ts-ignore wtf
      const { localMusicList } = state;
      // If yes, add it if no
      const exist = localMusicList.find((music: LocalMusicValue) => {
        if (music.id === data.id) {
          Object.assign(music, data);
          return true;
        }
        return false;
      });
      if (!exist) {
        localMusicList.push(data);
      }
      return { ...state, localMusicList: [...localMusicList] };
    },
  },
  {
    // loaded: 1, // Whether the panel is loaded for the first time after network configuration
    lights: [], // Color light data
    whiteLights: [], // White light data
    scenes: [],
    totalCountdown: 0,
  }
);

export const reducers = {
  dpState,
  devInfo,
  panelState,
  uiState,
  cloudState,
};
