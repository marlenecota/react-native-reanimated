#pragma once

#include "JSValue.h"
#include "NativeModules.h"

using namespace winrt::Microsoft::ReactNative;

namespace winrt::Reanimated
{

REACT_MODULE(ReactNativeModule, L"ReanimatedModule")
struct ReactNativeModule
{
  REACT_SYNC_METHOD(installTurboModule)
  bool installTurboModule(std::string valueUnpackerCode) noexcept {
    return false;
  }
};

} // namespace winrt::Reanimated
