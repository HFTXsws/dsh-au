    function visibleMenuParams(item, platformOs) {
      return (Array.isArray(item?.params) ? item.params : []).filter((param) => !param.platform || param.platform === platformOs);
    }

    function menuParamOptions(param, platformOs) {
      return (Array.isArray(param?.options) ? param.options : []).filter((opt) => !opt.platform || opt.platform === platformOs);
    }

    function isMenuParamTrue(value) {
      return value === true || value === 'true' || value === 1 || value === '1';
    }

    function menuParamFlag(param, isWin) {
      if (isWin) {
        if (Object.prototype.hasOwnProperty.call(param, 'winFlag')) return param.winFlag;
        if (Object.prototype.hasOwnProperty.call(param, 'posixFlag')) return param.posixFlag;
        return '';
      }
      if (Object.prototype.hasOwnProperty.call(param, 'posixFlag')) return param.posixFlag;
      if (Object.prototype.hasOwnProperty.call(param, 'winFlag')) return param.winFlag;
      return '';
    }

    function resolveMenuParamValue(param, params, platformOs) {
      const raw = params && Object.prototype.hasOwnProperty.call(params, param.name)
        ? params[param.name]
        : param.defaultValue;
      if (param.type === 'select') {
        const values = menuParamOptions(param, platformOs).map((opt) => opt.value);
        if (values.includes(raw)) return raw;
        if (values.includes(param.defaultValue)) return param.defaultValue;
        return values[0];
      }
      if (param.type === 'multiselect') {
        const allowed = new Set(menuParamOptions(param, platformOs).map((opt) => opt.value));
        const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? raw.split(',') : []);
        return list.filter((value) => allowed.has(value));
      }
      if (param.type === 'boolean') return isMenuParamTrue(raw);
      return raw == null ? '' : raw;
    }

    function appendMenuParamArgs(extraArgs, param, value, isWin) {
      if (param.type === 'boolean') {
        if (!isMenuParamTrue(value)) return;
        const flag = menuParamFlag(param, isWin);
        if (flag) extraArgs.push(flag);
        else extraArgs.push('true');
        return;
      }
      if (param.type === 'multiselect') {
        const joined = Array.isArray(value) ? value.filter(Boolean).join(',') : String(value || '');
        if (!joined && !param.required) return;
        const flag = menuParamFlag(param, isWin);
        if (flag) extraArgs.push(flag, joined);
        else extraArgs.push(joined);
        return;
      }
      const text = value == null ? '' : String(value).trim();
      if (!text && !param.required) return;
      const flag = menuParamFlag(param, isWin);
      if (flag) extraArgs.push(flag, text);
      else extraArgs.push(text);
    }

    /** 前端与后端同一套声明式 params 拼装，预览才能和真实命令一致。 */
    function buildMenuParamArgList(item, params, platformOs) {
      const isWin = platformOs === 'win32';
      const extraArgs = [...(item?.args || [])];
      for (const param of visibleMenuParams(item, platformOs)) {
        appendMenuParamArgs(extraArgs, param, resolveMenuParamValue(param, params, platformOs), isWin);
      }
      return extraArgs;
    }

    function collectMenuParams(item, paramValues, platformOs) {
      const out = {};
      for (const param of visibleMenuParams(item, platformOs)) {
        out[param.name] = resolveMenuParamValue(param, paramValues, platformOs);
      }
      return out;
    }

    function hasMenuPreFlightParams(item, platformOs) {
      return visibleMenuParams(item, platformOs).length > 0;
    }

    function canDirectRunMenu(item, platformOs) {
      return Boolean(item && !hasMenuPreFlightParams(item, platformOs) && !item.needsChildInput && !item.confirm);
    }

