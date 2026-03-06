provider "tencentcloud" {
  region = "ap-guangzhou"
}

provider "tencentcloud" {
  alias  = "guangzhou"
  region = "ap-guangzhou"
}

provider "tencentcloud" {
  alias  = "siliconvalley"
  region = "na-siliconvalley"
}

provider "tencentcloud" {
  # Tencent's US East (Virginia) region code is na-ashburn.
  alias  = "ashburn"
  region = "na-ashburn"
}

provider "tencentcloud" {
  alias  = "shanghai"
  region = "ap-shanghai"
}
