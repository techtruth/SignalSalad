provider "aws" {
  region = "us-east-2"
}

provider "aws" {
  alias  = "ohio"
  region = "us-east-2"
}

provider "aws" {
  alias  = "north_california"
  region = "us-west-1"
}

provider "aws" {
  alias  = "north_virginia"
  region = "us-east-1"
}
