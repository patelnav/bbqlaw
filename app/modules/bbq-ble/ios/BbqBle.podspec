Pod::Spec.new do |s|
  s.name           = 'BbqBle'
  s.version        = '1.0.0'
  s.summary        = 'Thin CoreBluetooth wrapper for BBQlaw.'
  s.description    = 'Generic CoreBluetooth central with state restoration. No thermometer knowledge.'
  s.author         = 'BBQlaw'
  s.homepage       = 'https://bbqlaw.app'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,swift}'
end
